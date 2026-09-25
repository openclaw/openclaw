import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import { expectDefined } from "@openclaw/normalization-core";
import { Type, type Static } from "typebox";
import { tryResolveLegacyCompatibilityAgentId } from "../../config/legacy.default-agent-owner.js";
import { resolvePersistedSessionStoreOwnerForKey } from "../../config/sessions/session-store-owner.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createAbortError } from "../../infra/abort-signal.js";
import { parseAgentSessionKey } from "../../routing/session-key.js";
import { resolveSubagentCompletionResultText } from "../subagents/completion/subagent-completion-result.js";
import { onSubagentRegistryPersisted } from "../subagents/registry/subagent-registry-state.js";
import { prepareSubagentRunsByRunIds } from "../subagents/registry/subagent-registry.js";
import type { SubagentRunRecord } from "../subagents/registry/subagent-registry.types.js";
import { markCollectorReaderTool } from "../subagents/swarm/swarm-collector-capability.js";
import { resolveSwarmConfig } from "../subagents/swarm/swarm-config.js";
import { describeAgentsWaitTool } from "../tool-description-presets.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, ToolInputError } from "./common.js";

const MAX_WAIT_IDS = 1_000;

const AgentsWaitToolSchema = Type.Object({
  ids: Type.Array(Type.String({ minLength: 1 }), { minItems: 1, maxItems: MAX_WAIT_IDS }),
  timeoutSeconds: Type.Optional(Type.Number({ minimum: 0 })),
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
    structured: Type.Optional(Type.Unknown()),
    error: Type.Optional(Type.String()),
    schemaError: Type.Optional(Type.String()),
    sessionKey: Type.String(),
    label: Type.Optional(Type.String()),
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

type WaitError = { runId: string; error: "not_found" | "not_owner" };

function ownsRun(
  entry: SubagentRunRecord,
  currentSessionKeys: ReadonlySet<string>,
  currentAgentId?: string,
  config?: OpenClawConfig,
): boolean {
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
  return {
    runId: entry.swarmRunId ?? entry.runId,
    status: completion.status,
    result: resolveSubagentCompletionResultText(entry) ?? "",
    ...(completion.structured !== undefined ? { structured: completion.structured } : {}),
    ...(entry.execution.outcome?.status === "error"
      ? { error: entry.execution.outcome.error }
      : {}),
    ...(completion.schemaError ? { schemaError: completion.schemaError } : {}),
    sessionKey: entry.childSessionKey,
    ...(entry.label ? { label: entry.label } : {}),
    ...(completion.usage ? { usage: completion.usage } : {}),
  };
}

export type CollectorCompletionResult = NonNullable<ReturnType<typeof completionResult>>;

/** Park one host bridge until its collector completes; registry writes wake it without polling. */
export async function waitForCollectorCompletion(params: {
  runId: string;
  currentSessionKeys: ReadonlySet<string>;
  currentAgentId?: string;
  config?: OpenClawConfig;
  signal?: AbortSignal;
}): Promise<CollectorCompletionResult> {
  const state = await waitForCollector({
    ...params,
    ids: [params.runId],
    abortError: () => new ToolInputError("agents.run wait aborted."),
  });
  const error = state.errors?.[0];
  if (error) {
    throw new ToolInputError(`agents.run ${error.error}: ${error.runId}`);
  }
  return expectDefined(state.completed[0], "collector completion");
}

function readWaitState(
  entries: ReadonlyMap<string, SubagentRunRecord>,
  ids: readonly string[],
  currentSessionKeys: ReadonlySet<string>,
  currentAgentId?: string,
  config?: OpenClawConfig,
) {
  const errors: WaitError[] = [];
  const completed: Array<{
    result: NonNullable<ReturnType<typeof completionResult>>;
    completedAt: number;
    inputIndex: number;
  }> = [];
  const pending: string[] = [];
  for (const [inputIndex, runId] of ids.entries()) {
    const entry = entries.get(runId);
    if (!entry?.collect) {
      errors.push({ runId, error: "not_found" });
      continue;
    }
    if (!ownsRun(entry, currentSessionKeys, currentAgentId, config)) {
      errors.push({ runId, error: "not_owner" });
      continue;
    }
    const result = completionResult(entry);
    if (result) {
      completed.push({
        result,
        completedAt:
          entry.completion?.capturedAt ?? entry.execution.endedAt ?? Number.MAX_SAFE_INTEGER,
        inputIndex,
      });
    } else {
      pending.push(runId);
    }
  }
  completed.sort(
    (left, right) => left.completedAt - right.completedAt || left.inputIndex - right.inputIndex,
  );
  return {
    completed: completed.map((entry) => entry.result),
    pending,
    ...(errors.length > 0 ? { errors } : {}),
  };
}

async function waitForCollector(params: {
  ids: readonly string[];
  currentSessionKeys: ReadonlySet<string>;
  currentAgentId?: string;
  config?: OpenClawConfig;
  timeoutMs?: number;
  signal?: AbortSignal;
  abortError: () => Error;
}) {
  const deadline =
    params.timeoutMs === undefined ? undefined : performance.now() + params.timeoutMs;
  let changed: boolean;
  let resume: (() => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const wake = () => {
    changed = true;
    resume?.();
  };
  const assertNotAborted = () => {
    if (params.signal?.aborted) {
      throw params.abortError();
    }
  };
  // Cover the worker read as well as the parked wait; publications during either need a reread.
  const unsubscribe = onSubagentRegistryPersisted(wake);
  params.signal?.addEventListener("abort", wake, { once: true });
  try {
    for (;;) {
      assertNotAborted();
      changed = false;
      let read: { ready: true; value: ReturnType<typeof readWaitState> } | { ready: false };
      let callbackAbort: Error | undefined;
      try {
        const prepared = await prepareSubagentRunsByRunIds(params.ids);
        read = prepared.consume((entries) => {
          if (params.signal?.aborted) {
            callbackAbort = params.abortError();
            throw callbackAbort;
          }
          return readWaitState(
            entries,
            params.ids,
            params.currentSessionKeys,
            params.currentAgentId,
            params.config,
          );
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
        state.completed.length > 0 ||
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
        if (deadline !== undefined) {
          timer = setTimeout(resolve, Math.max(0, deadline - performance.now()));
        }
      });
      clearTimeout(timer);
      timer = undefined;
      resume = undefined;
    }
  } finally {
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
  const swarm = resolveSwarmConfig(opts.config, opts.agentId);
  return markCollectorReaderTool({
    label: "Wait for Agents",
    name: "agents_wait",
    displaySummary: "Wait for collector children.",
    description: describeAgentsWaitTool(false),
    parameters: AgentsWaitToolSchema,
    outputSchema: AgentsWaitOutputSchema,
    execute: async (_toolCallId, args, signal) => {
      const params = args as { ids: string[]; timeoutSeconds?: number };
      if (params.ids.length > MAX_WAIT_IDS) {
        throw new ToolInputError(`agents_wait supports at most ${MAX_WAIT_IDS} ids.`);
      }
      const ids = [...new Set(params.ids.map((id) => id.trim()).filter(Boolean))];
      if (ids.length === 0) {
        throw new ToolInputError("agents_wait requires at least one non-empty run id.");
      }
      const currentSessionKeys = new Set(
        [opts.runSessionKey, opts.agentSessionKey].filter((key): key is string =>
          Boolean(key?.trim()),
        ),
      );
      const requestedTimeout =
        typeof params.timeoutSeconds === "number" && Number.isFinite(params.timeoutSeconds)
          ? params.timeoutSeconds
          : 30;
      const timeoutSeconds = Math.min(Math.max(0, requestedTimeout), swarm.waitTimeoutSecondsMax);
      const result = await waitForCollector({
        ids,
        currentSessionKeys,
        currentAgentId: opts.agentId,
        config: opts.config,
        timeoutMs: timeoutSeconds * 1_000,
        signal,
        abortError: () => createAbortError("agents_wait aborted."),
      });
      const noAuthorizedTargets =
        result.completed.length === 0 &&
        result.pending.length === 0 &&
        Boolean(result.errors?.length);
      return jsonResult(noAuthorizedTargets ? { ...result, success: false } : result);
    },
  });
}
