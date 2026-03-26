import path from "node:path";
import { Type } from "@sinclair/typebox";
import { type OpenClawConfig, loadConfig } from "../../config/config.js";
import {
  resolveSessionFilePath,
  resolveSessionFilePathOptions,
  resolveStorePath,
} from "../../config/sessions.js";
import { callGateway } from "../../gateway/call.js";
import { resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readStringArrayParam } from "./common.js";
import {
  createSessionVisibilityGuard,
  createAgentToAgentPolicy,
  classifySessionKind,
  deriveChannel,
  resolveDisplaySessionKey,
  resolveEffectiveSessionToolsVisibility,
  resolveInternalSessionKey,
  resolveSandboxedSessionToolContext,
  type SessionListRow,
  stripToolMessages,
} from "./sessions-helpers.js";

const SessionsListToolSchema = Type.Object({
  kinds: Type.Optional(Type.Array(Type.String())),
  limit: Type.Optional(Type.Number({ minimum: 1 })),
  activeMinutes: Type.Optional(Type.Number({ minimum: 1 })),
  messageLimit: Type.Optional(Type.Number({ minimum: 0 })),
});

type GatewayCaller = typeof callGateway;

export function createSessionsListTool(opts?: {
  agentSessionKey?: string;
  sandboxed?: boolean;
  config?: OpenClawConfig;
  callGateway?: GatewayCaller;
}): AnyAgentTool {
  return {
    label: "Sessions",
    name: "sessions_list",
    description: "List sessions with optional filters and last messages.",
    parameters: SessionsListToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const cfg = opts?.config ?? loadConfig();
      const { mainKey, alias, requesterInternalKey, restrictToSpawned } =
        resolveSandboxedSessionToolContext({
          cfg,
          agentSessionKey: opts?.agentSessionKey,
          sandboxed: opts?.sandboxed,
        });
      const effectiveRequesterKey = requesterInternalKey ?? alias;
      const visibility = resolveEffectiveSessionToolsVisibility({
        cfg,
        sandboxed: opts?.sandboxed === true,
      });

      const kindsRaw = readStringArrayParam(params, "kinds")?.map((value) =>
        value.trim().toLowerCase(),
      );
      const allowedKindsList = (kindsRaw ?? []).filter((value) =>
        ["main", "group", "cron", "hook", "node", "other"].includes(value),
      );
      const allowedKinds = allowedKindsList.length ? new Set(allowedKindsList) : undefined;

      const limit =
        typeof params.limit === "number" && Number.isFinite(params.limit)
          ? Math.max(1, Math.floor(params.limit))
          : undefined;
      const activeMinutes =
        typeof params.activeMinutes === "number" && Number.isFinite(params.activeMinutes)
          ? Math.max(1, Math.floor(params.activeMinutes))
          : undefined;
      const messageLimitRaw =
        typeof params.messageLimit === "number" && Number.isFinite(params.messageLimit)
          ? Math.max(0, Math.floor(params.messageLimit))
          : 0;
      const messageLimit = Math.min(messageLimitRaw, 20);
      const gatewayCall = opts?.callGateway ?? callGateway;

      const list = await gatewayCall<{ sessions: Array<SessionListRow>; path: string }>({
        method: "sessions.list",
        params: {
          limit,
          activeMinutes,
          includeGlobal: !restrictToSpawned,
          includeUnknown: !restrictToSpawned,
          spawnedBy: restrictToSpawned ? effectiveRequesterKey : undefined,
        },
      });

      const sessions = Array.isArray(list?.sessions) ? list.sessions : [];
      const storePath = typeof list?.path === "string" ? list.path : undefined;
      const a2aPolicy = createAgentToAgentPolicy(cfg);
      const visibilityGuard = await createSessionVisibilityGuard({
        action: "list",
        requesterSessionKey: effectiveRequesterKey,
        visibility,
        a2aPolicy,
      });
      const rows: SessionListRow[] = [];
      const historyTargets: Array<{ row: SessionListRow; resolvedKey: string }> = [];

      for (const entry of sessions) {
        if (!entry || typeof entry !== "object") {
          continue;
        }
        const key = typeof entry.key === "string" ? entry.key : "";
        if (!key) {
          continue;
        }
        const access = visibilityGuard.check(key);
        if (!access.allowed) {
          continue;
        }

        if (key === "unknown") {
          continue;
        }
        if (key === "global" && alias !== "global") {
          continue;
        }

        const gatewayKind = typeof entry.kind === "string" ? entry.kind : undefined;
        const kind = classifySessionKind({ key, gatewayKind, alias, mainKey });
        if (allowedKinds && !allowedKinds.has(kind)) {
          continue;
        }

        const displayKey = resolveDisplaySessionKey({
          key,
          alias,
          mainKey,
        });

        const entryChannel = typeof entry.channel === "string" ? entry.channel : undefined;
        const deliveryContext =
          entry.deliveryContext && typeof entry.deliveryContext === "object"
            ? (entry.deliveryContext as Record<string, unknown>)
            : undefined;
        const deliveryChannel =
          typeof deliveryContext?.channel === "string" ? deliveryContext.channel : undefined;
        const deliveryTo = typeof deliveryContext?.to === "string" ? deliveryContext.to : undefined;
        const deliveryAccountId =
          typeof deliveryContext?.accountId === "string" ? deliveryContext.accountId : undefined;
        const lastChannel =
          deliveryChannel ??
          (typeof entry.lastChannel === "string" ? entry.lastChannel : undefined);
        const lastAccountId =
          deliveryAccountId ??
          (typeof entry.lastAccountId === "string" ? entry.lastAccountId : undefined);
        const derivedChannel = deriveChannel({
          key,
          kind,
          channel: entryChannel,
          lastChannel,
        });

        const sessionId = typeof entry.sessionId === "string" ? entry.sessionId : undefined;
        const sessionFileRaw = (entry as { sessionFile?: unknown }).sessionFile;
        const sessionFile = typeof sessionFileRaw === "string" ? sessionFileRaw : undefined;
        let transcriptPath: string | undefined;
        if (sessionId) {
          try {
            const agentId = resolveAgentIdFromSessionKey(key);
            const trimmedStorePath = storePath?.trim();
            let effectiveStorePath: string | undefined;
            if (trimmedStorePath && trimmedStorePath !== "(multiple)") {
              if (trimmedStorePath.includes("{agentId}") || trimmedStorePath.startsWith("~")) {
                effectiveStorePath = resolveStorePath(trimmedStorePath, { agentId });
              } else if (path.isAbsolute(trimmedStorePath)) {
                effectiveStorePath = trimmedStorePath;
              }
            }
            const filePathOpts = resolveSessionFilePathOptions({
              agentId,
              storePath: effectiveStorePath,
            });
            transcriptPath = resolveSessionFilePath(
              sessionId,
              sessionFile ? { sessionFile } : undefined,
              filePathOpts,
            );
          } catch {
            transcriptPath = undefined;
          }
        }

        const row: SessionListRow = {
          key: displayKey,
          kind,
          channel: derivedChannel,
          label: typeof entry.label === "string" ? entry.label : undefined,
          displayName: typeof entry.displayName === "string" ? entry.displayName : undefined,
          deliveryContext:
            deliveryChannel || deliveryTo || deliveryAccountId
              ? {
                  channel: deliveryChannel,
                  to: deliveryTo,
                  accountId: deliveryAccountId,
                }
              : undefined,
          updatedAt: typeof entry.updatedAt === "number" ? entry.updatedAt : undefined,
          sessionId,
          model: typeof entry.model === "string" ? entry.model : undefined,
          contextTokens: typeof entry.contextTokens === "number" ? entry.contextTokens : undefined,
          totalTokens: typeof entry.totalTokens === "number" ? entry.totalTokens : undefined,
          estimatedCostUsd:
            typeof entry.estimatedCostUsd === "number" ? entry.estimatedCostUsd : undefined,
          status: typeof entry.status === "string" ? entry.status : undefined,
          startedAt: typeof entry.startedAt === "number" ? entry.startedAt : undefined,
          endedAt: typeof entry.endedAt === "number" ? entry.endedAt : undefined,
          runtimeMs: typeof entry.runtimeMs === "number" ? entry.runtimeMs : undefined,
          childSessions: Array.isArray(entry.childSessions)
            ? entry.childSessions
                .filter((value): value is string => typeof value === "string")
                .map((value) =>
                  resolveDisplaySessionKey({
                    key: value,
                    alias,
                    mainKey,
                  }),
                )
            : undefined,
          thinkingLevel: typeof entry.thinkingLevel === "string" ? entry.thinkingLevel : undefined,
          verboseLevel: typeof entry.verboseLevel === "string" ? entry.verboseLevel : undefined,
          systemSent: typeof entry.systemSent === "boolean" ? entry.systemSent : undefined,
          abortedLastRun:
            typeof entry.abortedLastRun === "boolean" ? entry.abortedLastRun : undefined,
          sendPolicy: typeof entry.sendPolicy === "string" ? entry.sendPolicy : undefined,
          lastChannel,
          lastTo: deliveryTo ?? (typeof entry.lastTo === "string" ? entry.lastTo : undefined),
          lastAccountId,
          transcriptPath,
        };
        if (messageLimit > 0) {
          const resolvedKey = resolveInternalSessionKey({
            key,
            alias,
            mainKey,
          });
          historyTargets.push({ row, resolvedKey });
        }
        rows.push(row);
      }

      if (messageLimit > 0 && historyTargets.length > 0) {
        const maxConcurrent = Math.min(4, historyTargets.length);
        let index = 0;
        const worker = async () => {
          while (true) {
            const next = index;
            index += 1;
            if (next >= historyTargets.length) {
              return;
            }
            const target = historyTargets[next];
            const history = await gatewayCall<{ messages: Array<unknown> }>({
              method: "chat.history",
              params: { sessionKey: target.resolvedKey, limit: messageLimit },
            });
            const rawMessages = Array.isArray(history?.messages) ? history.messages : [];
            const filtered = stripToolMessages(rawMessages);
            target.row.messages =
              filtered.length > messageLimit ? filtered.slice(-messageLimit) : filtered;
          }
        };
        await Promise.all(Array.from({ length: maxConcurrent }, () => worker()));
      }

      return jsonResult({
        count: rows.length,
        sessions: rows,
      });
    },
  };
}
