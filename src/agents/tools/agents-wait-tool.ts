import { AsyncLocalStorage } from "node:async_hooks";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { safeParseJson } from "@openclaw/normalization-core/json-coercion";
import { asFiniteNumber } from "@openclaw/normalization-core/number-coercion";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import {
  attachInternalToolResultAcknowledgement,
  copyInternalToolResultState,
} from "../../../packages/agent-core/src/internal-hooks.js";
import { tryResolveLegacyCompatibilityAgentId } from "../../config/legacy.default-agent-owner.js";
import { resolvePersistedSessionStoreOwnerForKey } from "../../config/sessions/session-store-owner.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createAbortError } from "../../infra/abort-signal.js";
import { parseAgentSessionKey } from "../../routing/session-key.js";
import { defaultRuntime } from "../../runtime.js";
import { readNestedToolActivity } from "../../sessions/nested-tool-activity.js";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
import { createLazyImportLoader } from "../../shared/lazy-promise.js";
import type { AgentMessage } from "../runtime/index.js";
import {
  captureRequesterSessionEntryCurrent,
  loadRequesterSessionEntry,
} from "../subagents/announce/subagent-announce-delivery.runtime.js";
import { resolveSubagentCompletionResultText } from "../subagents/completion/subagent-completion-result.js";
import { recordSubagentFailureHandoff } from "../subagents/registry/subagent-failure-handoff.js";
import { capFrozenResultText } from "../subagents/registry/subagent-registry-helpers.js";
import { subscribeSubagentRunChanges } from "../subagents/registry/subagent-registry-publication.js";
import { matchesSubagentRequesterSession } from "../subagents/registry/subagent-registry-queries.js";
import { prepareSubagentRunsByRunIds } from "../subagents/registry/subagent-registry.js";
import type { SubagentRunRecord } from "../subagents/registry/subagent-registry.types.js";
import { isFailedTerminalSubagentRun } from "../subagents/subagent-failure.js";
import { markCollectorReaderTool } from "../subagents/swarm/swarm-collector-capability.js";
import { resolveSwarmConfig } from "../subagents/swarm/swarm-config.js";
import { describeAgentsWaitTool } from "../tool-description-presets.js";
import { toToolSearchJsonSafe } from "../tool-search-json.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, ToolInputError } from "./common.js";
import {
  captureGatewayToolCallerAssertion,
  getGatewayToolCallerIdentity,
} from "./gateway-caller-context.js";

const MAX_WAIT_IDS = 1_000;

const finalAnswerLoader = createLazyImportLoader(
  () => import("../subagents/announce/subagent-announce-output.js"),
);
const UNAVAILABLE_ANSWER_NOTICE =
  "\n\n[truncated: the complete child answer is unavailable; this is its 4,096-character preview]";

const AgentsWaitToolSchema = Type.Object({
  ids: Type.Array(Type.String({ minLength: 1 }), { minItems: 1, maxItems: MAX_WAIT_IDS }),
  timeoutSeconds: Type.Optional(Type.Number({ minimum: 0 })),
  awaitResults: Type.Optional(
    Type.Boolean({
      description:
        "Join required collector results until settlement or cancellation, without polling; mutually exclusive with timeoutSeconds. Child and agent budgets still apply.",
    }),
  ),
});

const CollectorCompletionSchema = Type.Object(
  {
    runId: Type.String(),
    status: Type.Union([
      Type.Literal("done"),
      Type.Literal("failed"),
      Type.Literal("killed"),
      Type.Literal("timeout"),
    ]),
    result: Type.String(),
    // The result may be incomplete: its complete text was unavailable or exceeded 100 KB.
    resultTruncated: Type.Optional(Type.Literal(true)),
    structured: Type.Optional(Type.Unknown()),
    error: Type.Optional(Type.String()),
    schemaError: Type.Optional(Type.String()),
    reason: Type.Optional(Type.Literal("yielded_without_result")),
    sessionKey: Type.String(),
    label: Type.Optional(Type.String()),
    groupId: Type.Optional(Type.String()),
    runtimeMs: Type.Optional(Type.Number({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })),
    usage: Type.Optional(
      Type.Object(
        { inputTokens: Type.Number(), outputTokens: Type.Number() },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);

const AgentsWaitOutputSchema = Type.Object(
  {
    completed: Type.Array(CollectorCompletionSchema),
    pending: Type.Array(Type.String()),
    errors: Type.Optional(
      Type.Array(
        Type.Object(
          {
            runId: Type.String(),
            error: Type.Union([Type.Literal("not_found"), Type.Literal("not_owner")]),
          },
          { additionalProperties: false },
        ),
      ),
    ),
    success: Type.Optional(Type.Literal(false)),
  },
  { additionalProperties: false },
);

type WaitError = NonNullable<Static<typeof AgentsWaitOutputSchema>["errors"]>[number];

type CollectorOwnerScope = {
  consumerSessionKey?: string;
  currentSessionKeys: ReadonlySet<string>;
  currentAgentId?: string;
  config?: OpenClawConfig;
  expectedRequester?: { sessionId: string; lifecycleRevision?: string };
};

// Hooks see the call ID and may invoke other tools with it. The per-tool marker
// survives wrapper spreads; correlation strings alone never select an owner.
const NATIVE_COLLECTOR_IDENTITY = Symbol.for("openclaw.nativeCollectorIdentity");
type NativeCollectorTool = AnyAgentTool & { [NATIVE_COLLECTOR_IDENTITY]?: symbol };
const nativeCollectorOwner = resolveGlobalSingleton(
  Symbol.for("openclaw.nativeSubagentCollectorOwner"),
  () =>
    new AsyncLocalStorage<{
      identity: symbol;
      toolCallId: string;
      owner: CollectorOwnerScope & { assertCurrent: () => void };
    }>(),
);

export function withNativeSubagentCollectorOwner<T>(
  tool: NativeCollectorTool,
  toolCallId: string,
  owner: CollectorOwnerScope & { assertCurrent: () => void },
  run: () => T,
): T {
  const identity = tool[NATIVE_COLLECTOR_IDENTITY];
  if (!identity) {
    throw new ToolInputError("Native collection requires its original collector tool.");
  }
  return nativeCollectorOwner.run({ identity, toolCallId, owner }, run);
}

/** The finalized tool may return a policy denial instead of its declared output. */
export function readNativeSubagentCollection(details: unknown) {
  if (!Value.Check(AgentsWaitOutputSchema, details)) {
    const failure = asOptionalRecord(details);
    const reason = failure?.reason ?? failure?.error;
    throw new ToolInputError(
      typeof reason === "string" ? reason : "Native subagent collection was not accepted.",
    );
  }
  return details;
}

function ownsRun(
  entry: SubagentRunRecord,
  { currentSessionKeys, currentAgentId, config, expectedRequester }: CollectorOwnerScope,
): boolean {
  if (expectedRequester && !matchesSubagentRequesterSession(entry, expectedRequester)) {
    return false;
  }
  const owner = entry.swarmRequesterSessionKey?.trim();
  if (!owner) {
    return false;
  }
  const authorizedSessionKeys =
    entry.swarmWaitOwnerSessionKeys && entry.swarmWaitOwnerSessionKeys.length > 0
      ? entry.swarmWaitOwnerSessionKeys
      : [owner];
  return authorizedSessionKeys.some((sessionKey) => {
    if (!currentSessionKeys.has(sessionKey)) {
      return false;
    }
    const ownerAgentId =
      parseAgentSessionKey(sessionKey)?.agentId ??
      entry.requesterAgentId ??
      paramsOwner(config, sessionKey);
    return Boolean(ownerAgentId && (!currentAgentId || ownerAgentId === currentAgentId));
  });
}

function paramsOwner(config: OpenClawConfig | undefined, sessionKey: string): string | undefined {
  if (!config) {
    return undefined;
  }
  const persisted = resolvePersistedSessionStoreOwnerForKey(config, sessionKey);
  return persisted.kind === "configured"
    ? persisted.agentId
    : persisted.kind === "none"
      ? tryResolveLegacyCompatibilityAgentId(config)
      : undefined;
}

function completionResult(
  entry: SubagentRunRecord,
): Static<typeof CollectorCompletionSchema> | undefined {
  const completion = entry.collectorCompletion;
  if (!completion) {
    return undefined;
  }
  const elapsed =
    (entry.execution.endedAt ?? Number.NaN) - (entry.execution.startedAt ?? Number.NaN);
  const runtimeMs =
    Number.isFinite(elapsed) && elapsed >= 0 && elapsed <= Number.MAX_SAFE_INTEGER
      ? elapsed
      : undefined;
  return {
    runId: entry.swarmRunId ?? entry.runId,
    status: completion.status,
    result: resolveSubagentCompletionResultText(entry) ?? "",
    ...(completion.structured !== undefined ? { structured: completion.structured } : {}),
    ...(entry.execution.outcome?.status === "error" || entry.execution.outcome?.status === "timeout"
      ? { error: entry.execution.outcome.error }
      : {}),
    ...(completion.schemaError ? { schemaError: completion.schemaError } : {}),
    ...(completion.reason ? { reason: completion.reason } : {}),
    sessionKey: entry.childSessionKey,
    ...(entry.label ? { label: entry.label } : {}),
    ...(entry.groupId ? { groupId: entry.groupId } : {}),
    ...(runtimeMs !== undefined ? { runtimeMs } : {}),
    ...(completion.usage ? { usage: completion.usage } : {}),
  };
}

export type CollectorCompletionResult = NonNullable<ReturnType<typeof completionResult>>;

/**
 * Lifecycle evidence keeps a 4,096-character reply preview. Return the run's recorded
 * answer or failure cause and saved progress within the shared 100 KB bound for frozen
 * collector results.
 */
async function completeCollectorResult(
  result: CollectorCompletionResult,
  entry: SubagentRunRecord,
  readCurrent: (runId: string) => SubagentRunRecord | undefined,
): Promise<CollectorCompletionResult> {
  if (
    entry.execution.outcome?.status === "error" ||
    entry.execution.outcome?.status === "timeout"
  ) {
    const prepared = await finalAnswerLoader
      .load()
      .then((output) => output.readSubagentRunAnnounceResult(entry, readCurrent));
    if (!prepared.isCurrent()) {
      throw new ToolInputError("Collector result changed during preparation.");
    }
    const text = prepared.text ?? result.result;
    const bounded = capFrozenResultText(text);
    return {
      ...result,
      result: bounded,
      ...(bounded !== text.trim() ? { resultTruncated: true as const } : {}),
    };
  }
  const preview = entry.completion?.terminalReply;
  // Only a capped preview ends with this marker; trimming can shorten it, so length proves nothing.
  if (
    preview?.disposition !== "visible" ||
    result.result !== preview.text ||
    !preview.text.endsWith("…")
  ) {
    return result;
  }
  const answer =
    entry.execution.outcome?.status === "ok"
      ? await finalAnswerLoader
          .load()
          .then((output) => output.readSubagentRunFinalAnswer(entry))
          .catch(() => undefined)
      : undefined;
  if (!answer?.trim()) {
    return {
      ...result,
      result: `${result.result}${UNAVAILABLE_ANSWER_NOTICE}`,
      resultTruncated: true,
    };
  }
  const bounded = capFrozenResultText(answer);
  return bounded === answer.trim()
    ? { ...result, result: bounded }
    : { ...result, result: bounded, resultTruncated: true };
}

/** Park one host bridge until its collector completes; registry writes wake it without polling. */
export async function waitForCollectorCompletion(
  params: CollectorOwnerScope & { runId: string; signal?: AbortSignal; assertCurrent?: () => void },
): Promise<CollectorCompletionResult> {
  const state = await waitForCollector({
    ...params,
    ids: [params.runId],
    abortError: () => new ToolInputError("agents.run wait aborted."),
  });
  const error = state.errors?.[0];
  if (error) {
    throw new ToolInputError(`agents.run ${error.error}: ${error.runId}`);
  }
  return copyInternalToolResultState(
    state,
    expectDefined(state.completed[0], "collector completion"),
  );
}

function readWaitState(
  entries: ReadonlyMap<string, SubagentRunRecord>,
  ids: readonly string[],
  owner: CollectorOwnerScope,
) {
  const errors: WaitError[] = [];
  const completed: Array<{
    result: CollectorCompletionResult;
    entry: SubagentRunRecord;
    completedAt: number;
    inputIndex: number;
  }> = [];
  const pending: string[] = [];
  const announcing: string[] = [];
  for (const [inputIndex, runId] of ids.entries()) {
    const entry = entries.get(runId);
    if (!entry?.collect) {
      // Session-mode children may deliver to a bound thread instead of the requester.
      if (
        entry?.expectsCompletionMessage &&
        entry.spawnMode !== "session" &&
        owner.currentSessionKeys.has(entry.requesterSessionKey)
      ) {
        announcing.push(runId);
      }
      errors.push({ runId, error: "not_found" });
      continue;
    }
    if (!ownsRun(entry, owner)) {
      errors.push({ runId, error: "not_owner" });
      continue;
    }
    const result = completionResult(entry);
    if (result) {
      completed.push({
        result,
        entry,
        completedAt:
          entry.completion?.capturedAt ?? entry.execution.endedAt ?? Number.MAX_SAFE_INTEGER,
        inputIndex,
      });
    } else {
      pending.push(runId);
    }
  }
  if (announcing.length === ids.length) {
    // Mixed batches keep per-ID results; an announcing-only wait gets delivery guidance instead.
    throw new ToolInputError(
      `agents_wait only collects runs started with collect=true. ${announcing.join(", ")} will report back to this session as a completion message; continue other work or end the turn instead of waiting.`,
    );
  }
  completed.sort(
    (left, right) => left.completedAt - right.completedAt || left.inputIndex - right.inputIndex,
  );
  return {
    completed: completed.map(({ result, entry }) => ({ result, entry })),
    pending,
    ...(errors.length > 0 ? { errors } : {}),
  };
}

type CollectorWaitParams = CollectorOwnerScope & {
  ids: readonly string[];
  timeoutMs?: number;
  waitForAll?: boolean;
  signal?: AbortSignal;
  abortError: () => Error;
  assertCurrent?: () => void;
};

/** Only whole structured results prove retention; child-authored nested text is never identity. */
function readCommittedCollectorResults(message?: AgentMessage): CollectorCompletionResult[] {
  if (!message) {
    return [];
  }
  const content =
    message.role === "toolResult"
      ? message.content
      : (readNestedToolActivity(message)?.details.result.content ?? []);
  return content.flatMap((block) => {
    const part = asOptionalRecord(block);
    if (part?.type !== "text" || typeof part.text !== "string") {
      return [];
    }
    // Truncated JSON cannot establish which source's diagnostics survived.
    const value = safeParseJson(part.text);
    return Value.Check(AgentsWaitOutputSchema, value)
      ? value.completed
      : Value.Check(CollectorCompletionSchema, value)
        ? [value]
        : [];
  });
}

async function waitForCollector(params: CollectorWaitParams) {
  const state = await waitForCollectorState(params);
  const completed = await Promise.all(
    state.completed.map(({ result, entry }) =>
      completeCollectorResult(result, entry, state.readCurrent),
    ),
  );
  // Transcript reads happen after the registry wait; recheck its effect-time authority.
  params.assertCurrent?.();
  if (params.signal?.aborted) {
    throw params.abortError();
  }
  const { readCurrent: _readCurrent, ...result } = state;
  const output = { ...result, completed };
  // Capture the JSON form before result hooks can mutate the exposed collection.
  const failed = state.completed.flatMap(({ entry }, index) =>
    isFailedTerminalSubagentRun(entry)
      ? [{ entry, expected: toToolSearchJsonSafe(completed[index]) }]
      : [],
  );
  const caller = getGatewayToolCallerIdentity();
  const callerAssertion = captureGatewayToolCallerAssertion();
  const consumerSessionKey = caller?.sessionKey ?? params.consumerSessionKey;
  if (!failed.length || (!params.assertCurrent && !callerAssertion) || !consumerSessionKey) {
    return output;
  }
  const assertCurrent = () => {
    params.assertCurrent?.();
    callerAssertion?.();
    if (params.signal?.aborted) {
      throw params.abortError();
    }
  };
  // A read is not consumption. Only the host's durable tool-result ACK records it.
  const requester = await loadRequesterSessionEntry(
    consumerSessionKey,
    params.currentAgentId,
  ).catch(() => undefined);
  assertCurrent();
  if (!requester?.entry || !requester.physicalStorePath) {
    return output;
  }
  const consumer = { ...params, currentSessionKeys: new Set([requester.canonicalKey]) };
  if (failed.some(({ entry }) => !ownsRun(entry, consumer))) {
    return output;
  }
  const gateway = caller?.gatewayContextResolver?.();
  const capturedRequester = {
    sessionKey: requester.canonicalKey,
    sessionId: requester.entry.sessionId,
    storePath: requester.physicalStorePath,
  };
  const lifecycleRevision = requester.entry.lifecycleRevision;
  return attachInternalToolResultAcknowledgement(output, (committedMessage) => {
    const represented = readCommittedCollectorResults(committedMessage);
    const retained = failed
      .filter(({ expected }) =>
        represented.some((candidate) => isDeepStrictEqual(candidate, expected)),
      )
      .map(({ entry }) => entry);
    if (!retained.length) {
      return;
    }
    const commit = async () => {
      assertCurrent();
      const recipient = await captureRequesterSessionEntryCurrent(
        capturedRequester.sessionKey,
        params.currentAgentId,
      );
      try {
        await recordSubagentFailureHandoff({
          entries: retained,
          requester: capturedRequester,
          collector: { lifecycleRevision, ownsRun: (entry) => ownsRun(entry, consumer) },
          assertCurrent: () => {
            assertCurrent();
            const current = recipient.readCurrent();
            if (
              current?.sessionId !== capturedRequester.sessionId ||
              current.lifecycleRevision !== lifecycleRevision
            ) {
              throw new ToolInputError("Collector consumer changed before consumption.");
            }
            for (const entry of retained) {
              const source = state.readCurrent(entry.runId);
              if (!source || !ownsRun(source, consumer)) {
                throw new ToolInputError("Collector result source changed before consumption.");
              }
            }
          },
        });
      } finally {
        recipient.release();
      }
    };
    void (gateway ? gateway.trackExecution(commit) : commit()).catch((error: unknown) => {
      defaultRuntime.log(
        "[warn] Collector failure handoff could not be recorded: " + String(error),
      );
    });
  });
}

async function waitForCollectorState(params: CollectorWaitParams) {
  const watchdogAttempt = getGatewayToolCallerIdentity()?.watchdogAttempt;
  const assertCurrent = captureGatewayToolCallerAssertion();
  const deadline =
    params.timeoutMs === undefined ? undefined : performance.now() + params.timeoutMs;
  let changed: boolean;
  let resume: (() => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let watchdogWait: ReturnType<NonNullable<typeof watchdogAttempt>["beginWait"]> | undefined;
  const wake = () => {
    changed = true;
    resume?.();
  };
  const assertNotAborted = () => {
    params.assertCurrent?.();
    if (params.signal?.aborted) {
      throw params.abortError();
    }
  };
  // Cover the worker read as well as the parked wait; publications during either need a reread.
  const unsubscribe = subscribeSubagentRunChanges("persistence", wake);
  params.signal?.addEventListener("abort", wake, { once: true });
  try {
    for (;;) {
      assertNotAborted();
      changed = false;
      let read:
        | {
            ready: true;
            value: ReturnType<typeof readWaitState> & {
              readCurrent: (runId: string) => SubagentRunRecord | undefined;
            };
          }
        | { ready: false };
      let callbackAbort: Error | undefined;
      try {
        const prepared = await prepareSubagentRunsByRunIds(params.ids);
        read = prepared.consume((entries) => {
          if (params.signal?.aborted) {
            callbackAbort = params.abortError();
            throw callbackAbort;
          }
          params.assertCurrent?.();
          return {
            ...readWaitState(entries, params.ids, params),
            readCurrent: (runId: string) => {
              const current = prepared.consume((runs) =>
                [...runs.values()].find((run) => run.runId === runId),
              );
              return current.ready ? current.value : undefined;
            },
          };
        });
      } catch (error) {
        if (params.signal?.aborted && error !== callbackAbort) {
          const aborted = params.abortError();
          aborted.cause = error;
          throw aborted;
        }
        throw error;
      }
      // Join the read before releasing listeners, even when cancellation wins.
      assertNotAborted();
      if (!read.ready) {
        await yieldToEventLoop();
        continue;
      }
      const state = read.value;
      if (
        (!params.waitForAll && state.completed.length > 0) ||
        state.pending.length === 0 ||
        (deadline !== undefined && performance.now() >= deadline)
      ) {
        return state;
      }
      if (changed) {
        await yieldToEventLoop();
        continue;
      }
      await new Promise<void>((resolve) => {
        resume = resolve;
        // Protect only the authorized parked wait; publications end protection
        // before any registry or transcript reread. Execution deadlines still apply.
        watchdogWait = watchdogAttempt?.beginWait({
          kind: "runtime_owned",
          isCurrent: () => {
            if (resume === undefined || changed || params.signal?.aborted) {
              return false;
            }
            params.assertCurrent?.();
            assertCurrent?.();
            return true;
          },
        });
        if (deadline !== undefined) {
          timer = setTimeout(resolve, Math.max(0, deadline - performance.now()));
        }
      });
      watchdogWait?.close();
      watchdogWait = undefined;
      clearTimeout(timer);
      timer = undefined;
      resume = undefined;
    }
  } finally {
    watchdogWait?.close();
    clearTimeout(timer);
    unsubscribe();
    params.signal?.removeEventListener("abort", wake);
  }
}

export function createAgentsWaitTool(opts: {
  agentSessionKey?: string;
  runSessionKey?: string;
  agentId?: string;
  config?: OpenClawConfig;
}): AnyAgentTool {
  const identity = Symbol("nativeCollector");
  return markCollectorReaderTool({
    [NATIVE_COLLECTOR_IDENTITY]: identity,
    label: "Wait for Agents",
    name: "agents_wait",
    displaySummary: "Wait for collector children.",
    description: describeAgentsWaitTool(false),
    parameters: AgentsWaitToolSchema,
    outputSchema: AgentsWaitOutputSchema,
    execute: async (toolCallId, args, signal) => {
      const params = args as Static<typeof AgentsWaitToolSchema>;
      if (!Array.isArray(params?.ids) || params.ids.some((id) => typeof id !== "string")) {
        throw new ToolInputError("agents_wait ids must be an array of run id strings.");
      }
      const scope = nativeCollectorOwner.getStore();
      const nativeOwner =
        scope?.identity === identity && scope.toolCallId === toolCallId ? scope.owner : undefined;
      const assertToolAllowed = getGatewayToolCallerIdentity()?.assertToolAllowed;
      const result = await collectNativeSubagentResults({
        ...params,
        currentSessionKeys: new Set(
          [opts.runSessionKey, opts.agentSessionKey].filter((key): key is string =>
            Boolean(key?.trim()),
          ),
        ),
        consumerSessionKey: opts.runSessionKey ?? opts.agentSessionKey,
        currentAgentId: opts.agentId,
        config: opts.config,
        ...nativeOwner,
        assertCurrent:
          nativeOwner || assertToolAllowed
            ? () => {
                nativeOwner?.assertCurrent();
                assertToolAllowed?.("agents_wait");
              }
            : undefined,
        signal,
      });
      return jsonResult(result);
    },
  });
}

/** Native event-driven collector, with optional exact requester and effect-time authority. */
async function collectNativeSubagentResults(
  params: CollectorOwnerScope & {
    ids: string[];
    timeoutSeconds?: number;
    awaitResults?: boolean;
    signal?: AbortSignal;
    assertCurrent?: () => void;
  },
) {
  params.assertCurrent?.();
  const swarm = resolveSwarmConfig(params.config, params.currentAgentId);
  if (params.awaitResults !== undefined && typeof params.awaitResults !== "boolean") {
    throw new ToolInputError("agents_wait awaitResults must be a boolean.");
  }
  if (params.awaitResults && params.timeoutSeconds !== undefined) {
    throw new ToolInputError(
      "agents_wait with awaitResults=true cannot also specify timeoutSeconds.",
    );
  }
  if (params.ids.length > MAX_WAIT_IDS) {
    throw new ToolInputError(`agents_wait supports at most ${MAX_WAIT_IDS} ids.`);
  }
  const ids = [...new Set(params.ids.map((id) => id.trim()).filter(Boolean))];
  if (ids.length === 0) {
    throw new ToolInputError("agents_wait requires at least one non-empty run id.");
  }
  const currentSessionKeys = params.currentSessionKeys;
  const requestedTimeout = asFiniteNumber(params.timeoutSeconds) ?? 30;
  const timeoutSeconds = Math.min(Math.max(0, requestedTimeout), swarm.waitTimeoutSecondsMax);
  const result = await waitForCollector({
    ids,
    currentSessionKeys,
    consumerSessionKey: params.consumerSessionKey,
    currentAgentId: params.currentAgentId,
    config: params.config,
    timeoutMs: params.awaitResults ? undefined : timeoutSeconds * 1_000,
    waitForAll: params.awaitResults,
    signal: params.signal,
    assertCurrent: params.assertCurrent,
    expectedRequester: params.expectedRequester,
    abortError: () => createAbortError("agents_wait aborted."),
  });
  const noAuthorizedTargets =
    result.completed.length === 0 && result.pending.length === 0 && Boolean(result.errors?.length);
  return noAuthorizedTargets ? { ...result, success: false as const } : result;
}
