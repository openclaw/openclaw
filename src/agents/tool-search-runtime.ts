import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { getPluginToolMeta } from "../plugins/tool-metadata.js";
import { sortAndLimitBy } from "../shared/sort-and-limit.js";
import { resolveAgentToolExecutionSchema } from "./agent-tool-availability.js";
import {
  finalizeToolTerminalPresentation,
  getBeforeToolCallFailureDisposition,
  isPreExecutionBlockedToolResult,
} from "./agent-tools.before-tool-call.js";
import { runWithToolExecutionValidation } from "./agent-tools.execution-validation.js";
import { getChannelAgentToolMeta } from "./channel-tool-metadata.js";
import { collectTextContentBlocks } from "./content-blocks.js";
import { setMcpCodeModeGuestResultFromAgentResult } from "./mcp-content.js";
import { captureAgentPluginRuntimeRefresh } from "./plugin-runtime-refresh.js";
import type { AgentToolResult } from "./runtime/index.js";
import {
  captureToolOutputSelection,
  readToolOutputSchemaVariants,
  type ToolOutputSelection,
  selectToolOutputSchema,
} from "./schema/tool-output-schema.js";
import { bindJoinedCollectorInvocation } from "./subagents/swarm/swarm-collector-capability.js";
import { markToolContractFailure } from "./tool-contract-error.js";
import { getToolInvocationMetadata } from "./tool-invocation-metadata.js";
import { isAgentToolReplaySafe } from "./tool-replay-safety.js";
import {
  isToolResultError,
  isTrustedToolExecutionPreflightError,
  protectNetworkToolExecutionError,
} from "./tool-result-error.js";
import {
  compactToolSearchCatalogEntry,
  prepareToolSearchCatalogExecutionTool,
  readToolSearchCatalogTelemetry,
  resolveCatalog,
  visibleCatalogEntries,
} from "./tool-search-catalog.js";
import {
  renderToolSearchControlText,
  serializeToolSearchControlResult,
} from "./tool-search-control-result.js";
import { getToolSearchLexicalIndex } from "./tool-search-index.js";
import { scoreLexical, tokenizeQuery } from "./tool-search-ranking.js";
import {
  formatCatalogInputError,
  formatCatalogOutputError,
  formatUnknownToolIdError,
  type ToolLookupErrorOptions,
} from "./tool-search-recovery.js";
import { readToolSearchLimit } from "./tool-search-request.js";
import { runScheduledToolSearchCall } from "./tool-search-scheduling.js";
import { snapshotToolSearchTargetTranscriptResult } from "./tool-search-transcript.js";
import type {
  CatalogVisibilityOptions,
  ToolSearchCallOptions,
  ToolSearchCatalogEntry,
  ToolSearchCatalogSession,
  ToolSearchCatalogToolExecutor,
  ToolSearchConfig,
  ToolSearchToolContext,
  UnknownToolErrorOptions,
} from "./tool-search-types.js";
import { textResult, ToolInputError } from "./tools/common.js";

type ToolSearchExactCallOptions = Pick<
  ToolSearchCallOptions,
  "parentToolCallId" | "signal" | "onUpdate" | "recoverySurface" | "mcpNamespaceGuest"
>;

function describeEntry(entry: ToolSearchCatalogEntry) {
  return {
    ...compactToolSearchCatalogEntry(entry),
    parameters: entry.parameters ?? {},
    ...(entry.outputSchema ? { outputSchema: entry.outputSchema } : {}),
  };
}

function findEntry(
  catalog: ToolSearchCatalogSession,
  id: string,
  options?: CatalogVisibilityOptions & ToolLookupErrorOptions,
  match: "id-or-name" | "exact-id" = "id-or-name",
): ToolSearchCatalogEntry {
  const needle = id.trim();
  const entries = match === "exact-id" ? catalog.entries : visibleCatalogEntries(catalog, options);
  const exactIdEntry = entries.find((candidate) => candidate.id === needle);
  if (exactIdEntry) {
    return exactIdEntry;
  }
  const namedEntries =
    match === "exact-id" ? [] : entries.filter((candidate) => candidate.name === needle);
  if (namedEntries.length > 1) {
    throw new ToolInputError(`Ambiguous tool name: ${needle}; use an exact tool id.`);
  }
  const namedEntry = namedEntries[0];
  if (!namedEntry) {
    throw new ToolInputError(
      formatUnknownToolIdError(
        needle,
        entries,
        match === "exact-id" ? { ...options, exactIdOnly: true } : options,
      ),
    );
  }
  return namedEntry;
}

type CatalogSchemaName = "inputSchema" | "outputSchema";
type CatalogSchemaValidation = ReturnType<
  typeof import("../plugins/schema-validator.js").validateJsonSchemaValue
>;
let schemaValidatorModulePromise:
  | Promise<typeof import("../plugins/schema-validator.js")>
  | undefined;

async function validateCatalogSchemaValue(
  entry: ToolSearchCatalogEntry,
  schemaName: CatalogSchemaName,
  value: unknown,
  outputSelection?: ToolOutputSelection,
): Promise<CatalogSchemaValidation | undefined> {
  let schema =
    schemaName === "inputSchema"
      ? resolveAgentToolExecutionSchema(entry.tool, entry.parameters)
      : entry.outputSchema;
  if (entry.source !== "openclaw") {
    return undefined;
  }
  try {
    if (schemaName === "outputSchema") {
      if (
        outputSelection &&
        readToolOutputSchemaVariants(schema)?.inputProperty !== outputSelection.inputProperty
      ) {
        throw new Error("Tool output discriminator changed during execution.");
      }
      schema = selectToolOutputSchema(
        schema,
        outputSelection ? { [outputSelection.inputProperty]: outputSelection.value } : undefined,
      );
    }
    if (!schema) {
      return undefined;
    }
    schemaValidatorModulePromise ??= import("../plugins/schema-validator.js");
    const { validateJsonSchemaValue } = await schemaValidatorModulePromise;
    return validateJsonSchemaValue({
      schema: schema as never,
      value,
    });
  } catch (error) {
    throw markToolContractFailure(
      new Error(`Tool "${entry.id}" has an invalid ${schemaName}.`, { cause: error }),
      "invalid_contract",
    );
  }
}

async function assertCatalogInputMatchesSchema(
  entry: ToolSearchCatalogEntry,
  value: unknown,
): Promise<void> {
  const validation = await validateCatalogSchemaValue(entry, "inputSchema", value);
  if (validation && !validation.ok) {
    throw markToolContractFailure(
      new ToolInputError(formatCatalogInputError(entry, validation.errors, value)),
      "input_contract",
    );
  }
}

async function assertCatalogOutputSchemaIsValid(entry: ToolSearchCatalogEntry): Promise<void> {
  // Compile before execution so a bad contract cannot follow a successful side effect.
  await validateCatalogSchemaValue(entry, "outputSchema", undefined);
}

async function assertCatalogOutputMatchesSchema(
  entry: ToolSearchCatalogEntry,
  result: AgentToolResult<unknown>,
  outputSelection?: ToolOutputSelection,
): Promise<void> {
  if (!entry.outputSchema && !outputSelection) {
    return;
  }
  if (isPreExecutionBlockedToolResult(result)) {
    const details = unwrapToolResultValue(result);
    const reason =
      isRecord(details) && typeof details.reason === "string" && details.reason.trim()
        ? details.reason
        : "Tool call blocked by policy";
    throw new Error(`Tool "${entry.id}" was blocked before execution: ${reason}`);
  }
  const validation = await validateCatalogSchemaValue(
    entry,
    "outputSchema",
    unwrapToolResultValue(result),
    outputSelection,
  );
  if (!validation || validation.ok) {
    return;
  }
  throw markToolContractFailure(
    new Error(formatCatalogOutputError(entry, validation.errors)),
    "output_contract",
  );
}

function sanitizeToolCallIdPart(value: string): string {
  const safe = value.trim().replace(/[^A-Za-z0-9_.:-]+/g, "_");
  return safe.slice(0, 120) || "call";
}

export class ToolSearchRuntime {
  private readonly pluginRuntimeRefresh = captureAgentPluginRuntimeRefresh();
  private callSequence = 0;
  private readonly terminalTargetBatchByParent = new Map<string, boolean>();
  private readonly networkInvocations = new Map<string, { active: number; observed: boolean }>();

  constructor(
    private readonly ctx: ToolSearchToolContext,
    private readonly config: ToolSearchConfig,
    private readonly options: {
      prepareInput?: boolean;
      validateInput?: boolean;
      callIdScope?: string;
    } = {},
  ) {}

  search = async (
    query: string,
    options?: { limit?: number; parentToolCallId?: string } & CatalogVisibilityOptions,
  ) => {
    const catalog = resolveCatalog(this.ctx);
    catalog.searchCount += 1;
    const limit = readToolSearchLimit(options?.limit, this.config);
    const entries = visibleCatalogEntries(catalog, options);
    const compactEntry = (entry: ToolSearchCatalogEntry) => {
      if (entry.source !== "openclaw" && options?.parentToolCallId) {
        this.observeNetworkContent(options.parentToolCallId);
      }
      return compactToolSearchCatalogEntry(entry);
    };
    // A query that is exactly a tool name or id is a request for that tool, not
    // a description of one. BM25 alone can rank a shorter entry that merely
    // mentions the word above it, and the limit then drops the tool asked for.
    const spelling = query.trim();
    const exact = spelling.toLowerCase();
    const exactIdEntry = entries.find((entry) => entry.id === spelling);
    const exactMatches = exactIdEntry
      ? [exactIdEntry]
      : entries.filter(
          (entry) => entry.name.toLowerCase() === exact || entry.id.toLowerCase() === exact,
        );
    // An unambiguous exact lookup never needs schema traversal or a BM25 index.
    if (limit === 1 && exactMatches.length === 1) {
      return exactMatches.slice(0, limit).map(compactEntry);
    }
    const index = getToolSearchLexicalIndex(catalog.entries, entries);
    // Resolve shared positions only against this search's effective catalog.
    const hits = scoreLexical(index, tokenizeQuery(query));
    const exactMatchSet = new Set(exactMatches);
    // A tool whose name is a stopword ("do") tokenizes to nothing and so never
    // reaches the ranking at all. Naming it exactly is still an unambiguous
    // request for it, which the previous scorer honored.
    const exactEntries = exactMatches.filter(
      (entry) => !hits.some((hit) => entries[hit.value] === entry),
    );
    const remaining = limit - exactEntries.length;
    const ranked =
      remaining > 0
        ? sortAndLimitBy(
            hits,
            remaining,
            (a, b) =>
              Number(exactMatchSet.has(entries[b.value]!)) -
                Number(exactMatchSet.has(entries[a.value]!)) ||
              Number(b.matchedLiteral) - Number(a.matchedLiteral) ||
              b.score - a.score ||
              entries[a.value]!.id.localeCompare(entries[b.value]!.id),
          ).map((hit) => entries[hit.value]!)
        : [];
    return [...exactEntries, ...ranked].slice(0, limit).map(compactEntry);
  };

  all = (options?: CatalogVisibilityOptions) =>
    visibleCatalogEntries(resolveCatalog(this.ctx), options).map(compactToolSearchCatalogEntry);

  namespaceEntries = () =>
    // Snapshot host metadata without rendering hints or retaining the executable tool.
    resolveCatalog(this.ctx).entries.map(
      ({ tool: _tool, outputSchema: _outputSchema, ...entry }) => {
        entry.parameters ??= {};
        return entry;
      },
    );

  describe = async (
    id: string,
    options?: CatalogVisibilityOptions & UnknownToolErrorOptions & { parentToolCallId?: string },
  ) => {
    const catalog = resolveCatalog(this.ctx);
    catalog.describeCount += 1;
    const entry = findEntry(catalog, id, { ...options, codeModeSkills: this.ctx.codeModeSkills });
    if (entry.source !== "openclaw" && options?.parentToolCallId) {
      this.observeNetworkContent(options.parentToolCallId);
    }
    return describeEntry(entry);
  };

  invocationMetadata = (id: string, input: unknown) => {
    const entry = findEntry(resolveCatalog(this.ctx), id, {
      codeModeSkills: this.ctx.codeModeSkills,
    });
    return getToolInvocationMetadata(entry.tool, input);
  };

  call = async (id: string, input?: unknown, options?: ToolSearchCallOptions) => {
    const catalog = resolveCatalog(this.ctx);
    return await this.callEntry(
      findEntry(catalog, id, { ...options, codeModeSkills: this.ctx.codeModeSkills }),
      input,
      options,
    );
  };

  callExactId = async (id: string, input?: unknown, options?: ToolSearchExactCallOptions) => {
    const catalog = resolveCatalog(this.ctx);
    return await this.callEntry(
      findEntry(catalog, id, { ...options, codeModeSkills: this.ctx.codeModeSkills }, "exact-id"),
      input,
      options,
    );
  };

  callValue = async (id: string, input?: unknown, options?: ToolSearchCallOptions) =>
    projectToolResultValue((await this.call(id, input, options)).result);

  callExactValue = async (id: string, input?: unknown, options?: ToolSearchExactCallOptions) =>
    projectToolResultValue((await this.callExactId(id, input, options)).result);

  observeNetworkContent(parentToolCallId: string): void {
    const state = this.networkInvocations.get(parentToolCallId) ?? { active: 0, observed: false };
    state.observed = true;
    this.networkInvocations.set(parentToolCallId, state);
  }

  hasNetworkContent(parentToolCallId?: string): boolean {
    return parentToolCallId
      ? this.networkInvocations.has(parentToolCallId)
      : this.networkInvocations.size > 0;
  }

  takeTerminalTargetBatch(parentToolCallId?: string): boolean {
    const parent =
      parentToolCallId ??
      (this.terminalTargetBatchByParent.size === 1
        ? (this.terminalTargetBatchByParent.keys().next().value ?? "")
        : "");
    const terminal = this.terminalTargetBatchByParent.get(parent) === true;
    return this.terminalTargetBatchByParent.delete(parent) && terminal;
  }

  isReplaySafeExactId = (id: string): boolean => {
    let entry: ToolSearchCatalogEntry;
    try {
      entry = findEntry(resolveCatalog(this.ctx), id, undefined, "exact-id");
    } catch {
      return false;
    }
    if (entry.source !== "openclaw") {
      return false;
    }
    const pluginMeta = getPluginToolMeta(entry.tool as Parameters<typeof getPluginToolMeta>[0]);
    if (pluginMeta) {
      return pluginMeta.mcp
        ? false
        : pluginMeta.replaySafe === true && pluginMeta.sideEffecting !== true;
    }
    if (getChannelAgentToolMeta(entry.tool as never)) {
      return false;
    }
    return isAgentToolReplaySafe(entry.tool);
  };

  private readonly callEntry = (
    entry: ToolSearchCatalogEntry,
    input?: unknown,
    options?: ToolSearchCallOptions,
  ) =>
    runScheduledToolSearchCall({
      ctx: this.ctx,
      entry,
      signal: options?.signal,
      execute: (currentEntry, signal) =>
        this.executeEntry(resolveCatalog(this.ctx), currentEntry, input, { ...options, signal }),
    });

  private readonly executeEntry = async (
    catalog: ToolSearchCatalogSession,
    entry: ToolSearchCatalogEntry,
    input?: unknown,
    options?: Pick<
      ToolSearchCallOptions,
      "parentToolCallId" | "signal" | "onUpdate" | "mcpNamespaceGuest"
    >,
  ) => {
    this.pluginRuntimeRefresh.assertCurrent();
    catalog.callCount += 1;
    const normalizedInput = input ?? {};
    const parentId = sanitizeToolCallIdPart(options?.parentToolCallId ?? "direct");
    const scope = this.options.callIdScope
      ? `${sanitizeToolCallIdPart(this.options.callIdScope)}:`
      : "";
    const toolCallId = `tool_call:${parentId}:${scope}${entry.name}:${++this.callSequence}`;
    bindJoinedCollectorInvocation(entry.tool, toolCallId);
    await assertCatalogOutputSchemaIsValid(entry);
    const outputVariants =
      entry.source === "openclaw" ? readToolOutputSchemaVariants(entry.outputSchema) : undefined;
    const callerOutputSelection = outputVariants
      ? captureToolOutputSelection(outputVariants.inputProperty, normalizedInput)
      : undefined;
    let executedOutputSelection: ToolOutputSelection | undefined;
    const executeTool =
      this.ctx.executeTool ??
      (async (params: Parameters<ToolSearchCatalogToolExecutor>[0]) => {
        const result = await params.tool.execute(
          params.toolCallId,
          params.input,
          params.signal,
          params.onUpdate,
          undefined as never,
        );
        return await params.acceptResultBeforeProjection(result);
      });
    let preExecutionBlocked = false;
    // Reuse only this call's accepted snapshot; outer schema validation must still run.
    let acceptedSnapshot: AgentToolResult<unknown> | undefined;
    const acceptResultBeforeProjection = async (candidate: AgentToolResult<unknown>) => {
      if (isPreExecutionBlockedToolResult(candidate)) {
        // The JSON-safe snapshot drops the private blocked-result marker.
        preExecutionBlocked = true;
        if (entry.source === "mcp") {
          const operation = entry.mcp?.operation ?? "tool";
          if (operation === "tool") {
            setMcpCodeModeGuestResultFromAgentResult(candidate);
          } else if (options?.mcpNamespaceGuest) {
            const details = isRecord(candidate.details) ? candidate.details : undefined;
            const reason =
              typeof details?.reason === "string" && details.reason.trim()
                ? details.reason.trim()
                : "Tool call blocked by policy";
            throw new Error(`Tool "${entry.id}" was blocked before execution: ${reason}`);
          }
        }
        await assertCatalogOutputMatchesSchema(entry, candidate);
      }
      const snapshot =
        candidate === acceptedSnapshot
          ? candidate
          : snapshotToolSearchTargetTranscriptResult(candidate);
      await assertCatalogOutputMatchesSchema(entry, snapshot, executedOutputSelection);
      // Hook rewrites must also satisfy the result type advertised to the caller.
      if (callerOutputSelection && callerOutputSelection.value !== executedOutputSelection?.value) {
        await assertCatalogOutputMatchesSchema(entry, snapshot, callerOutputSelection);
      }
      acceptedSnapshot = snapshot;
      return snapshot;
    };
    const validateInput = this.options.validateInput && entry.source === "openclaw";
    const validateExecution = validateInput || outputVariants !== undefined;
    const executionTool = prepareToolSearchCatalogExecutionTool(entry, {
      ...this.options,
      validateInput: validateExecution,
    });
    const runExecution = async () => {
      this.pluginRuntimeRefresh.assertCurrent();
      const parentToolCallId = options?.parentToolCallId ?? toolCallId;
      const signal = options?.signal ?? this.ctx.abortSignal;
      const networkInvocation =
        entry.tool.resultContentSource === "network"
          ? (this.networkInvocations.get(parentToolCallId) ?? { active: 0, observed: false })
          : undefined;
      if (networkInvocation) {
        networkInvocation.active += 1;
        this.networkInvocations.set(parentToolCallId, networkInvocation);
      }
      try {
        const result = await executeTool({
          tool: executionTool,
          toolName: entry.name,
          source: entry.source,
          sourceName: entry.sourceName,
          toolCallId,
          parentToolCallId: options?.parentToolCallId,
          replaySafe: this.isReplaySafeExactId(entry.id),
          input: normalizedInput,
          signal,
          onUpdate: options?.onUpdate,
          acceptResultBeforeProjection,
        });
        if (networkInvocation && !preExecutionBlocked) {
          networkInvocation.observed = true;
        }
        return result;
      } catch (error) {
        if (
          networkInvocation &&
          !preExecutionBlocked &&
          getBeforeToolCallFailureDisposition(error) === undefined &&
          !isTrustedToolExecutionPreflightError(error) &&
          !(signal?.aborted && error === signal.reason)
        ) {
          // Guest code can catch page-controlled errors and return their text.
          networkInvocation.observed = true;
        }
        throw error;
      } finally {
        if (networkInvocation && --networkInvocation.active === 0 && !networkInvocation.observed) {
          this.networkInvocations.delete(parentToolCallId);
        }
      }
    };
    let acceptedResult: AgentToolResult<unknown> | undefined;
    try {
      const result = validateExecution
        ? await runWithToolExecutionValidation(
            toolCallId,
            async (finalInput) => {
              if (validateInput) {
                await assertCatalogInputMatchesSchema(entry, finalInput);
              }
              if (outputVariants) {
                // Retain the prepared primitive, not an input object the tool can mutate.
                executedOutputSelection = captureToolOutputSelection(
                  outputVariants.inputProperty,
                  finalInput,
                );
              }
            },
            runExecution,
          )
        : await runExecution();
      acceptedResult = await acceptResultBeforeProjection(result);
      if (options?.parentToolCallId) {
        this.terminalTargetBatchByParent.set(
          options.parentToolCallId,
          this.terminalTargetBatchByParent.get(options.parentToolCallId) !== false &&
            acceptedResult.terminate === true,
        );
      }
      return { tool: compactToolSearchCatalogEntry(entry), result: acceptedResult };
    } finally {
      // Nested executors can reject after raw success; only outer acceptance owns the summary.
      finalizeToolTerminalPresentation({
        toolCallId,
        runId: this.ctx.runId,
        result: acceptedResult ?? { content: [], details: undefined },
        isError: acceptedResult === undefined || isToolResultError(acceptedResult),
      });
    }
  };

  telemetry() {
    return readToolSearchCatalogTelemetry(this.ctx);
  }
}

/** Preserve programmatic values while protecting the model-facing control output. */
export function formatToolSearchControlResult<T>(
  payload: T,
  runtime: ToolSearchRuntime | undefined,
  options: {
    parentToolCallId?: string;
    terminalBatchStatus?: "waiting" | "completed" | "failed";
    compact?: boolean;
    images?: Extract<AgentToolResult<unknown>["content"][number], { type: "image" }>[];
  } = {},
): AgentToolResult<T> {
  const serialized = serializeToolSearchControlResult(payload, options.compact);
  const { text } = renderToolSearchControlText(
    serialized,
    runtime?.hasNetworkContent(options.parentToolCallId) ?? false,
  );
  const result = textResult(text, payload);
  if (options.images?.length) {
    result.content.push(...options.images);
  }
  const terminal =
    options.terminalBatchStatus !== "waiting" &&
    runtime?.takeTerminalTargetBatch(options.parentToolCallId) === true;
  // A failed guest cannot revoke an already completed tool's explicit terminal outcome.
  return terminal ? { ...result, terminate: true } : result;
}

/** Keep dynamic failures rejected without exposing network-controlled error text. */
export function formatToolSearchControlError(
  error: unknown,
  runtime: ToolSearchRuntime | undefined,
  parentToolCallId?: string,
  signal?: AbortSignal,
): unknown {
  if (
    !runtime?.hasNetworkContent(parentToolCallId) ||
    getBeforeToolCallFailureDisposition(error) !== undefined ||
    isTrustedToolExecutionPreflightError(error) ||
    (signal?.aborted && error === signal.reason)
  ) {
    return error;
  }
  return protectNetworkToolExecutionError(error, "Tool Search call failed.", signal);
}

function unwrapToolResultValue(result: AgentToolResult<unknown>): unknown {
  return isRecord(result) && "details" in result ? result.details : result;
}

/**
 * Project a target result into the value Code Mode guests receive. Output
 * contracts validate the raw details; only the guest value gains error text.
 */
function projectToolResultValue(result: AgentToolResult<unknown>): unknown {
  if (!isRecord(result) || !("details" in result)) {
    return result;
  }
  const { details } = result;
  // An explicit error can explain itself only in model-facing text; keep that reason.
  if (result.isError !== true || hasErrorMessage(details)) {
    return details;
  }
  const message = collectTextContentBlocks(result.content)
    .map((text) => text.trim())
    .filter(Boolean)
    .join("\n");
  if (!message) {
    return details;
  }
  if (details === undefined || details === null) {
    return { message };
  }
  return isRecord(details) ? { ...details, message } : details;
}

function hasErrorMessage(details: unknown): boolean {
  return (
    isRecord(details) &&
    [details.message, details.error].some((value) => typeof value === "string" && value.trim())
  );
}
