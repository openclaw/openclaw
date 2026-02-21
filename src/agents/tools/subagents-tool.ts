import crypto from "node:crypto";
import { Type } from "@sinclair/typebox";
import { clearSessionQueues } from "../../auto-reply/reply/queue.js";
import {
  resolveSubagentLabel,
  resolveSubagentTargetFromRuns,
  sortSubagentRuns,
  type SubagentTargetResolution,
} from "../../auto-reply/reply/subagents-utils.js";
import { loadConfig } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions.js";
import { loadSessionStore, resolveStorePath, updateSessionStore } from "../../config/sessions.js";
import { callGateway } from "../../gateway/call.js";
import { logVerbose } from "../../globals.js";
import {
  isSubagentSessionKey,
  parseAgentSessionKey,
  type ParsedAgentSessionKey,
} from "../../routing/session-key.js";
import {
  formatDurationCompact,
  formatTokenUsageDisplay,
  resolveTotalTokens,
  truncateLine,
} from "../../shared/subagents-format.js";
import { INTERNAL_MESSAGE_CHANNEL } from "../../utils/message-channel.js";
import { AGENT_LANE_SUBAGENT } from "../lanes.js";
import { abortEmbeddedPiRun } from "../pi-embedded.js";
import { optionalStringEnum } from "../schema/typebox.js";
import { getSubagentDepthFromSessionStore } from "../subagent-depth.js";
import {
  clearSubagentRunSteerRestart,
  listSubagentRunsForRequester,
  markSubagentRunTerminated,
  markSubagentRunForSteerRestart,
  replaceSubagentRunAfterSteer,
  type SubagentRunRecord,
} from "../subagent-registry.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readNumberParam, readStringParam } from "./common.js";
import { resolveInternalSessionKey, resolveMainSessionAlias } from "./sessions-helpers.js";

const SUBAGENT_ACTIONS = ["list", "kill", "steer"] as const;
type SubagentAction = (typeof SUBAGENT_ACTIONS)[number];

const DEFAULT_RECENT_MINUTES = 30;
const MAX_RECENT_MINUTES = 24 * 60;
const MAX_STEER_MESSAGE_CHARS = 4_000;
const STEER_RATE_LIMIT_MS = 2_000;
const STEER_ABORT_SETTLE_TIMEOUT_MS = 5_000;

const steerRateLimit = new Map<string, number>();

const SubagentsToolSchema = Type.Object({
  action: optionalStringEnum(SUBAGENT_ACTIONS),
  target: Type.Optional(Type.String()),
  message: Type.Optional(Type.String()),
  recentMinutes: Type.Optional(Type.Number({ minimum: 1 })),
});

type SessionEntryResolution = {
  storePath: string;
  entry: SessionEntry | undefined;
};

type ResolvedRequesterKey = {
  requesterSessionKey: string;
  callerSessionKey: string;
  callerIsSubagent: boolean;
};

function resolveRunStatus(entry: SubagentRunRecord) {
  if (!entry.endedAt) {
    return "running";
  }
  const status = entry.outcome?.status ?? "done";
  if (status === "ok") {
    return "done";
  }
  if (status === "error") {
    return "failed";
  }
  return status;
}

function resolveModelRef(entry?: SessionEntry) {
  const model = typeof entry?.model === "string" ? entry.model.trim() : "";
  const provider = typeof entry?.modelProvider === "string" ? entry.modelProvider.trim() : "";
  if (model.includes("/")) {
    return model;
  }
  if (model && provider) {
    return `${provider}/${model}`;
  }
  if (model) {
    return model;
  }
  if (provider) {
    return provider;
  }
  // Fall back to override fields which are populated at spawn time,
  // before the first run completes and writes model/modelProvider.
  const overrideModel = typeof entry?.modelOverride === "string" ? entry.modelOverride.trim() : "";
  const overrideProvider =
    typeof entry?.providerOverride === "string" ? entry.providerOverride.trim() : "";
  if (overrideModel.includes("/")) {
    return overrideModel;
  }
  if (overrideModel && overrideProvider) {
    return `${overrideProvider}/${overrideModel}`;
  }
  if (overrideModel) {
    return overrideModel;
  }
  return overrideProvider || undefined;
}

function resolveModelDisplay(entry?: SessionEntry, fallbackModel?: string) {
  const modelRef = resolveModelRef(entry) || fallbackModel || undefined;
  if (!modelRef) {
    return "model n/a";
  }
  const slash = modelRef.lastIndexOf("/");
  if (slash >= 0 && slash < modelRef.length - 1) {
    return modelRef.slice(slash + 1);
  }
  return modelRef;
}

function resolveSubagentTarget(
  runs: SubagentRunRecord[],
  token: string | undefined,
  options?: { recentMinutes?: number },
): SubagentTargetResolution {
  return resolveSubagentTargetFromRuns({
    runs,
    token,
    recentWindowMinutes: options?.recentMinutes ?? DEFAULT_RECENT_MINUTES,
    label: (entry) => resolveSubagentLabel(entry),
    errors: {
      missingTarget: "Missing subagent target.",
      invalidIndex: (value) => `Invalid subagent index: ${value}`,
      unknownSession: (value) => `Unknown subagent session: ${value}`,
      ambiguousLabel: (value) => `Ambiguous subagent label: ${value}`,
      ambiguousLabelPrefix: (value) => `Ambiguous subagent label prefix: ${value}`,
      ambiguousRunIdPrefix: (value) => `Ambiguous subagent run id prefix: ${value}`,
      unknownTarget: (value) => `Unknown subagent target: ${value}`,
    },
  });
}

function resolveStorePathForKey(
  cfg: ReturnType<typeof loadConfig>,
  key: string,
  parsed?: ParsedAgentSessionKey | null,
) {
  return resolveStorePath(cfg.session?.store, {
    agentId: parsed?.agentId,
  });
}

function resolveSessionEntryForKey(params: {
  cfg: ReturnType<typeof loadConfig>;
  key: string;
  cache: Map<string, Record<string, SessionEntry>>;
}): SessionEntryResolution {
  const parsed = parseAgentSessionKey(params.key);
  const storePath = resolveStorePathForKey(params.cfg, params.key, parsed);
  let store = params.cache.get(storePath);
  if (!store) {
    store = loadSessionStore(storePath);
    params.cache.set(storePath, store);
  }
  return {
    storePath,
    entry: store[params.key],
  };
}

function resolveRequesterKey(params: {
  cfg: ReturnType<typeof loadConfig>;
  agentSessionKey?: string;
}): ResolvedRequesterKey {
  const { mainKey, alias } = resolveMainSessionAlias(params.cfg);
  const callerRaw = params.agentSessionKey?.trim() || alias;
  const callerSessionKey = resolveInternalSessionKey({
    key: callerRaw,
    alias,
    mainKey,
  });
  if (!isSubagentSessionKey(callerSessionKey)) {
    return {
      requesterSessionKey: callerSessionKey,
      callerSessionKey,
      callerIsSubagent: false,
    };
  }

  // Check if this sub-agent can spawn children (orchestrator).
  // If so, it should see its own children, not its parent's children.
  const callerDepth = getSubagentDepthFromSessionStore(callerSessionKey, { cfg: params.cfg });
  const maxSpawnDepth = params.cfg.agents?.defaults?.subagents?.maxSpawnDepth ?? 1;
  if (callerDepth < maxSpawnDepth) {
    // Orchestrator sub-agent: use its own session key as requester
    // so it sees children it spawned.
    return {
      requesterSessionKey: callerSessionKey,
      callerSessionKey,
      callerIsSubagent: true,
    };
  }

  // Leaf sub-agent: walk up to its parent so it can see sibling runs.
  const cache = new Map<string, Record<string, SessionEntry>>();
  const callerEntry = resolveSessionEntryForKey({
    cfg: params.cfg,
    key: callerSessionKey,
    cache,
  }).entry;
  const spawnedBy = typeof callerEntry?.spawnedBy === "string" ? callerEntry.spawnedBy.trim() : "";
  return {
    requesterSessionKey: spawnedBy || callerSessionKey,
    callerSessionKey,
    callerIsSubagent: true,
  };
}

async function killSubagentRun(params: {
  cfg: ReturnType<typeof loadConfig>;
  entry: SubagentRunRecord;
  cache: Map<string, Record<string, SessionEntry>>;
}): Promise<{ killed: boolean; sessionId?: string }> {
  if (params.entry.endedAt) {
    return { killed: false };
  }
  const childSessionKey = params.entry.childSessionKey;
  const resolved = resolveSessionEntryForKey({
    cfg: params.cfg,
    key: childSessionKey,
    cache: params.cache,
  });
  const sessionId = resolved.entry?.sessionId;
  const aborted = sessionId ? abortEmbeddedPiRun(sessionId) : false;
  const cleared = clearSessionQueues([childSessionKey, sessionId]);
  if (cleared.followupCleared > 0 || cleared.laneCleared > 0) {
    logVerbose(
      `subagents tool kill: cleared followups=${cleared.followupCleared} lane=${cleared.laneCleared} keys=${cleared.keys.join(",")}`,
    );
  }
  if (resolved.entry) {
    await updateSessionStore(resolved.storePath, (store) => {
      const current = store[childSessionKey];
      if (!current) {
        return;
      }
      current.abortedLastRun = true;
      current.updatedAt = Date.now();
      store[childSessionKey] = current;
    });
  }
  const marked = markSubagentRunTerminated({
    runId: params.entry.runId,
    childSessionKey,
    reason: "killed",
  });
  const killed = marked > 0 || aborted || cleared.followupCleared > 0 || cleared.laneCleared > 0;
  return { killed, sessionId };
}

/**
 * Recursively kill all descendant subagent runs spawned by a given parent session key.
 * This ensures that when a subagent is killed, all of its children (and their children) are also killed.
 */
async function cascadeKillChildren(params: {
  cfg: ReturnType<typeof loadConfig>;
  parentChildSessionKey: string;
  cache: Map<string, Record<string, SessionEntry>>;
  seenChildSessionKeys?: Set<string>;
}): Promise<{ killed: number; labels: string[] }> {
  const childRuns = listSubagentRunsForRequester(params.parentChildSessionKey);
  const seenChildSessionKeys = params.seenChildSessionKeys ?? new Set<string>();
  let killed = 0;
  const labels: string[] = [];

  for (const run of childRuns) {
    const childKey = run.childSessionKey?.trim();
    if (!childKey || seenChildSessionKeys.has(childKey)) {
      continue;
    }
    seenChildSessionKeys.add(childKey);

    if (!run.endedAt) {
      const stopResult = await killSubagentRun({
        cfg: params.cfg,
        entry: run,
        cache: params.cache,
      });
      if (stopResult.killed) {
        killed += 1;
        labels.push(resolveSubagentLabel(run));
      }
    }

    // Recurse for grandchildren even if this parent already ended.
    const cascade = await cascadeKillChildren({
      cfg: params.cfg,
      parentChildSessionKey: childKey,
      cache: params.cache,
      seenChildSessionKeys,
    });
    killed += cascade.killed;
    labels.push(...cascade.labels);
  }

  return { killed, labels };
}

function buildListText(params: {
  active: Array<{ line: string }>;
  recent: Array<{ line: string }>;
  recentMinutes: number;
}) {
  const lines: string[] = [];
  lines.push("active subagents:");
  if (params.active.length === 0) {
    lines.push("(none)");
  } else {
    lines.push(...params.active.map((entry) => entry.line));
  }
  lines.push("");
  lines.push(`recent (last ${params.recentMinutes}m):`);
  if (params.recent.length === 0) {
    lines.push("(none)");
  } else {
    lines.push(...params.recent.map((entry) => entry.line));
  }
  return lines.join("\n");
}

export function createSubagentsTool(opts?: { agentSessionKey?: string }): AnyAgentTool {
  return {
    label: "Subagents",
    name: "subagents",
    description:
      "List, kill, or steer spawned sub-agents for this requester session. Use this for sub-agent orchestration.",
    parameters: SubagentsToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const action = (readStringParam(params, "action") ?? "list") as SubagentAction;
      const cfg = loadConfig();
      const requester = resolveRequesterKey({
        cfg,
        agentSessionKey: opts?.agentSessionKey,
      });
      const runs = sortSubagentRuns(listSubagentRunsForRequester(requester.requesterSessionKey));
      const recentMinutesRaw = readNumberParam(params, "recentMinutes");
      const recentMinutes = recentMinutesRaw
        ? Math.max(1, Math.min(MAX_RECENT_MINUTES, Math.floor(recentMinutesRaw)))
        : DEFAULT_RECENT_MINUTES;

      if (action === "list") {
        const now = Date.now();
        const recentCutoff = now - recentMinutes * 60_000;
        const cache = new Map<string, Record<string, SessionEntry>>();

        let index = 1;
        const buildListEntry = (entry: SubagentRunRecord, runtimeMs: number) => {
          const sessionEntry = resolveSessionEntryForKey({
            cfg,
            key: entry.childSessionKey,
            cache,
          }).entry;
          const totalTokens = resolveTotalTokens(sessionEntry);
          const usageText = formatTokenUsageDisplay(sessionEntry);
          const status = resolveRunStatus(entry);
          const runtime = formatDurationCompact(runtimeMs);
          const label = truncateLine(resolveSubagentLabel(entry), 48);
          const task = truncateLine(entry.task.trim(), 72);
          const line = `${index}. ${label} (${resolveModelDisplay(sessionEntry, entry.model)}, ${runtime}${usageText ? `, ${usageText}` : ""}) ${status}${task.toLowerCase() !== label.toLowerCase() ? ` - ${task}` : ""}`;
          const baseView = {
            index,
            runId: entry.runId,
            sessionKey: entry.childSessionKey,
            label,
            task,
            status,
            runtime,
            runtimeMs,
            model: resolveModelRef(sessionEntry) || entry.model,
            totalTokens,
            startedAt: entry.startedAt,
          };
          index += 1;
          return { line, view: entry.endedAt ? { ...baseView, endedAt: entry.endedAt } : baseView };
        };
        const active = runs
          .filter((entry) => !entry.endedAt)
          .map((entry) => buildListEntry(entry, now - (entry.startedAt ?? entry.createdAt)));
        const recent = runs
          .filter((entry) => !!entry.endedAt && (entry.endedAt ?? 0) >= recentCutoff)
          .map((entry) =>
            buildListEntry(entry, (entry.endedAt ?? now) - (entry.startedAt ?? entry.createdAt)),
          );

        const text = buildListText({ active, recent, recentMinutes });
        return jsonResult({
          status: "ok",
          action: "list",
          requesterSessionKey: requester.requesterSessionKey,
          callerSessionKey: requester.callerSessionKey,
          callerIsSubagent: requester.callerIsSubagent,
          total: runs.length,
          active: active.map((entry) => entry.view),
          recent: recent.map((entry) => entry.view),
          text,
        });
      }

      if (action === "kill") {
        const target = readStringParam(params, "target", { required: true });
        if (target === "all" || target === "*") {
          const cache = new Map<string, Record<string, SessionEntry>>();
          const seenChildSessionKeys = new Set<string>();
          const killedLabels: string[] = [];
          let killed = 0;
          for (const entry of runs) {
            const childKey = entry.childSessionKey?.trim();
            if (!childKey || seenChildSessionKeys.has(childKey)) {
              continue;
            }
            seenChildSessionKeys.add(childKey);

            if (!entry.endedAt) {
              const stopResult = await killSubagentRun({ cfg, entry, cache });
              if (stopResult.killed) {
                killed += 1;
                killedLabels.push(resolveSubagentLabel(entry));
              }
            }

            // Traverse descendants even when the direct run is already finished.
            const cascade = await cascadeKillChildren({
              cfg,
              parentChildSessionKey: childKey,
              cache,
              seenChildSessionKeys,
            });
            killed += cascade.killed;
            killedLabels.push(...cascade.labels);
          }
          return jsonResult({
            status: "ok",
            action: "kill",
            target: "all",
            killed,
            labels: killedLabels,
            text:
              killed > 0
                ? `killed ${killed} subagent${killed === 1 ? "" : "s"}.`
                : "no running subagents to kill.",
          });
        }
        const resolved = resolveSubagentTarget(runs, target, { recentMinutes });
        if (!resolved.entry) {
          return jsonResult({
            status: "error",
            action: "kill",
            target,
            error: resolved.error ?? "Unknown subagent target.",
          });
        }
        const killCache = new Map<string, Record<string, SessionEntry>>();
        const stopResult = await killSubagentRun({
          cfg,
          entry: resolved.entry,
          cache: killCache,
        });
        const seenChildSessionKeys = new Set<string>();
        const targetChildKey = resolved.entry.childSessionKey?.trim();
        if (targetChildKey) {
          seenChildSessionKeys.add(targetChildKey);
        }
        // Traverse descendants even when the selected run is already finished.
        const cascade = await cascadeKillChildren({
          cfg,
          parentChildSessionKey: resolved.entry.childSessionKey,
          cache: killCache,
          seenChildSessionKeys,
        });
        if (!stopResult.killed && cascade.killed === 0) {
          return jsonResult({
            status: "done",
            action: "kill",
            target,
            runId: resolved.entry.runId,
            sessionKey: resolved.entry.childSessionKey,
            text: `${resolveSubagentLabel(resolved.entry)} is already finished.`,
          });
        }
        const cascadeText =
          cascade.killed > 0
            ? ` (+ ${cascade.killed} descendant${cascade.killed === 1 ? "" : "s"})`
            : "";
        return jsonResult({
          status: "ok",
          action: "kill",
          target,
          runId: resolved.entry.runId,
          sessionKey: resolved.entry.childSessionKey,
          label: resolveSubagentLabel(resolved.entry),
          cascadeKilled: cascade.killed,
          cascadeLabels: cascade.killed > 0 ? cascade.labels : undefined,
          text: stopResult.killed
            ? `killed ${resolveSubagentLabel(resolved.entry)}${cascadeText}.`
            : `killed ${cascade.killed} descendant${cascade.killed === 1 ? "" : "s"} of ${resolveSubagentLabel(resolved.entry)}.`,
        });
      }
      if (action === "steer") {
        const target = readStringParam(params, "target", { required: true });
        const message = readStringParam(params, "message", { required: true });
        if (message.length > MAX_STEER_MESSAGE_CHARS) {
          return jsonResult({
            status: "error",
            action: "steer",
            target,
            error: `Message too long (${message.length} chars, max ${MAX_STEER_MESSAGE_CHARS}).`,
          });
        }
        const resolved = resolveSubagentTarget(runs, target, { recentMinutes });
        if (!resolved.entry) {
          return jsonResult({
            status: "error",
            action: "steer",
            target,
            error: resolved.error ?? "Unknown subagent target.",
          });
        }
        if (resolved.entry.endedAt) {
          return jsonResult({
            status: "done",
            action: "steer",
            target,
            runId: resolved.entry.runId,
            sessionKey: resolved.entry.childSessionKey,
            text: `${resolveSubagentLabel(resolved.entry)} is already finished.`,
          });
        }
        if (
          requester.callerIsSubagent &&
          requester.callerSessionKey === resolved.entry.childSessionKey
        ) {
          return jsonResult({
            status: "forbidden",
            action: "steer",
            target,
            runId: resolved.entry.runId,
            sessionKey: resolved.entry.childSessionKey,
            error: "Subagents cannot steer themselves.",
          });
        }

        const rateKey = `${requester.callerSessionKey}:${resolved.entry.childSessionKey}`;
        const now = Date.now();
        const lastSentAt = steerRateLimit.get(rateKey) ?? 0;
        if (now - lastSentAt < STEER_RATE_LIMIT_MS) {
          return jsonResult({
            status: "rate_limited",
            action: "steer",
            target,
            runId: resolved.entry.runId,
            sessionKey: resolved.entry.childSessionKey,
            error: "Steer rate limit exceeded. Wait a moment before sending another steer.",
          });
        }
        steerRateLimit.set(rateKey, now);

        // Suppress announce for the interrupted run before aborting so we don't
        // emit stale pre-steer findings if the run exits immediately.
        markSubagentRunForSteerRestart(resolved.entry.runId);

        const targetSession = resolveSessionEntryForKey({
          cfg,
          key: resolved.entry.childSessionKey,
          cache: new Map<string, Record<string, SessionEntry>>(),
        });
        const sessionId =
          typeof targetSession.entry?.sessionId === "string" && targetSession.entry.sessionId.trim()
            ? targetSession.entry.sessionId.trim()
            : undefined;

        // Interrupt current work first so steer takes precedence immediately.
        if (sessionId) {
          abortEmbeddedPiRun(sessionId);
        }
        const cleared = clearSessionQueues([resolved.entry.childSessionKey, sessionId]);
        if (cleared.followupCleared > 0 || cleared.laneCleared > 0) {
          logVerbose(
            `subagents tool steer: cleared followups=${cleared.followupCleared} lane=${cleared.laneCleared} keys=${cleared.keys.join(",")}`,
          );
        }

        // Best effort: wait for the interrupted run to settle so the steer
        // message appends onto the existing conversation context.
        try {
          await callGateway({
            method: "agent.wait",
            params: {
              runId: resolved.entry.runId,
              timeoutMs: STEER_ABORT_SETTLE_TIMEOUT_MS,
            },
            timeoutMs: STEER_ABORT_SETTLE_TIMEOUT_MS + 2_000,
          });
        } catch {
          // Continue even if wait fails; steer should still be attempted.
        }

        const idempotencyKey = crypto.randomUUID();
        let runId: string = idempotencyKey;
        try {
          const response = await callGateway<{ runId: string }>({
            method: "agent",
            params: {
              message,
              sessionKey: resolved.entry.childSessionKey,
              sessionId,
              idempotencyKey,
              deliver: false,
              channel: INTERNAL_MESSAGE_CHANNEL,
              lane: AGENT_LANE_SUBAGENT,
              timeout: 0,
            },
            timeoutMs: 10_000,
          });
          if (typeof response?.runId === "string" && response.runId) {
            runId = response.runId;
          }
        } catch (err) {
          // Replacement launch failed; restore normal announce behavior for the
          // original run so completion is not silently suppressed.
          clearSubagentRunSteerRestart(resolved.entry.runId);
          const error = err instanceof Error ? err.message : String(err);
          return jsonResult({
            status: "error",
            action: "steer",
            target,
            runId,
            sessionKey: resolved.entry.childSessionKey,
            sessionId,
            error,
          });
        }

        replaceSubagentRunAfterSteer({
          previousRunId: resolved.entry.runId,
          nextRunId: runId,
          fallback: resolved.entry,
          runTimeoutSeconds: resolved.entry.runTimeoutSeconds ?? 0,
        });

        return jsonResult({
          status: "accepted",
          action: "steer",
          target,
          runId,
          sessionKey: resolved.entry.childSessionKey,
          sessionId,
          mode: "restart",
          label: resolveSubagentLabel(resolved.entry),
          text: `steered ${resolveSubagentLabel(resolved.entry)}.`,
        });
      }
      return jsonResult({
        status: "error",
        error: "Unsupported action.",
      });
    },
  };
}
