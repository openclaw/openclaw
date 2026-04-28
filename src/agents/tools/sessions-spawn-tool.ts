import crypto from "node:crypto";
import { Type } from "typebox";
import { isAcpRuntimeSpawnAvailable } from "../../acp/runtime/availability.js";
import { getRuntimeConfig } from "../../config/config.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { callGateway } from "../../gateway/call.js";
import { parseAgentSessionKey, normalizeAgentId } from "../../routing/session-key.js";
import { resolveUserPath } from "../../utils.js";
import { normalizeDeliveryContext } from "../../utils/delivery-context.shared.js";
import type { GatewayMessageChannel } from "../../utils/message-channel.js";
import {
  completeWorkObject,
  createWorkObject,
  runCodingFanout,
  type CodingFanoutOptions,
  type CodingFanoutResult,
} from "../../work-objects/index.js";
import {
  resolveAgentConfig,
  resolveAgentWorkspaceDir,
  resolveDefaultAgentId,
} from "../agent-scope.js";
import { optionalStringEnum } from "../schema/typebox.js";
import type { SpawnedToolContext } from "../spawned-context.js";
import { registerSubagentRun } from "../subagent-registry.js";
import {
  SUBAGENT_SPAWN_CONTEXT_MODES,
  SUBAGENT_SPAWN_MODES,
  spawnSubagentDirect,
} from "../subagent-spawn.js";
import {
  describeSessionsSpawnTool,
  SESSIONS_SPAWN_SUBAGENT_TOOL_DISPLAY_SUMMARY,
  SESSIONS_SPAWN_TOOL_DISPLAY_SUMMARY,
} from "../tool-description-presets.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readStringParam, ToolInputError } from "./common.js";
import {
  resolveDisplaySessionKey,
  resolveInternalSessionKey,
  resolveMainSessionAlias,
} from "./sessions-helpers.js";

const SESSIONS_SPAWN_RUNTIMES = ["subagent", "acp"] as const;
const SESSIONS_SPAWN_SANDBOX_MODES = ["inherit", "require"] as const;
const SESSIONS_SPAWN_WORKFLOWS = ["auto", "subagent", "coding-fanout"] as const;
// Keep the schema local to avoid a circular import through acp-spawn/openclaw-tools.
const SESSIONS_SPAWN_ACP_STREAM_TARGETS = ["parent"] as const;
const UNSUPPORTED_SESSIONS_SPAWN_PARAM_KEYS = [
  "target",
  "transport",
  "channel",
  "to",
  "threadId",
  "thread_id",
  "replyTo",
  "reply_to",
] as const;

type AcpSpawnModule = typeof import("../acp-spawn.js");

let acpSpawnModulePromise: Promise<AcpSpawnModule> | undefined;

async function loadAcpSpawnModule(): Promise<AcpSpawnModule> {
  acpSpawnModulePromise ??= import("../acp-spawn.js");
  return await acpSpawnModulePromise;
}

function summarizeError(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  if (typeof err === "string") {
    return err;
  }
  return "error";
}

function addRoleToFailureResult<T extends { status: string }>(
  result: T,
  role: string | undefined,
): T | (T & { role: string }) {
  if (!role || (result.status !== "error" && result.status !== "forbidden")) {
    return result;
  }
  return { ...result, role };
}

type SpawnWorkflow = (typeof SESSIONS_SPAWN_WORKFLOWS)[number];

function normalizeWorkflow(value: unknown): SpawnWorkflow | undefined {
  return value === "auto" || value === "subagent" || value === "coding-fanout" ? value : undefined;
}

function readStringArrayParam(params: Record<string, unknown>, key: string): string[] | undefined {
  const raw = params[key];
  if (!Array.isArray(raw)) {
    return undefined;
  }
  const values = raw
    .map((value) => (typeof value === "string" ? value.trim() : ""))
    .filter(Boolean);
  return values.length > 0 ? values : undefined;
}

export function isLikelyCodingTask(task: string): boolean {
  const text = task.toLowerCase();
  return /\b(build|implement|code|coding|fix|debug|refactor|test|lint|typecheck|compile|ship|pr|pull request|diff|commit|repo|repository|branch|typescript|javascript|python|rust|go|java|api|cli|frontend|backend)\b/.test(
    text,
  );
}

async function announceCodingFanoutResult(params: {
  requesterSessionKey: string;
  requesterOrigin?: ReturnType<typeof normalizeDeliveryContext>;
  task: string;
  label?: string;
  result: CodingFanoutResult;
}) {
  const proof = params.result.workObject?.proofPacket;
  const statusText =
    params.result.status === "succeeded"
      ? "completed successfully"
      : `finished with status ${params.result.status}`;
  const message = [
    `Coding fan-out ${statusText}.`,
    params.label ? `Label: ${params.label}` : undefined,
    `Task: ${params.task}`,
    params.result.workObject?.id ? `Work object: ${params.result.workObject.id}` : undefined,
    proof?.summary ? `Summary: ${proof.summary}` : undefined,
    proof?.output ? `Output:\n${proof.output.slice(0, 12_000)}` : undefined,
    params.result.missingRoles.length > 0
      ? `Missing roles: ${params.result.missingRoles.join(", ")}`
      : undefined,
    params.result.failedRoles.length > 0
      ? `Failed roles: ${params.result.failedRoles.join(", ")}`
      : undefined,
  ]
    .filter(Boolean)
    .join("\n\n");
  await callGateway({
    method: "agent",
    params: {
      sessionKey: params.requesterSessionKey,
      message,
      channel: params.requesterOrigin?.channel,
      accountId: params.requesterOrigin?.accountId,
      to: params.requesterOrigin?.to,
      threadId:
        params.requesterOrigin?.threadId != null
          ? String(params.requesterOrigin.threadId)
          : undefined,
      deliver: true,
      idempotencyKey: crypto.randomUUID(),
    },
    expectFinal: true,
    timeoutMs: 60_000,
  });
}

function resolveSpawnWorkflow(params: {
  requested?: SpawnWorkflow;
  targetAgentWorkflow?: SpawnWorkflow;
  defaultWorkflow?: SpawnWorkflow;
  task: string;
  hasExplicitModelOrThinking: boolean;
}): "subagent" | "coding-fanout" {
  const configured =
    params.requested ?? params.targetAgentWorkflow ?? params.defaultWorkflow ?? "auto";
  if (configured === "coding-fanout") {
    return "coding-fanout";
  }
  if (configured === "subagent") {
    return "subagent";
  }
  if (params.hasExplicitModelOrThinking) {
    return "subagent";
  }
  return isLikelyCodingTask(params.task) ? "coding-fanout" : "subagent";
}

function resolveCodingFanoutWorkspace(params: {
  requestedWorkspace?: string;
  targetAgentWorkspace?: string;
  defaultWorkspace?: string;
}): string {
  return (
    params.requestedWorkspace?.trim() ||
    params.targetAgentWorkspace?.trim() ||
    params.defaultWorkspace?.trim() ||
    process.cwd()
  );
}

function resolveTrackedSpawnMode(params: {
  requestedMode?: "run" | "session";
  threadRequested: boolean;
}): "run" | "session" {
  if (params.requestedMode === "run" || params.requestedMode === "session") {
    return params.requestedMode;
  }
  return params.threadRequested ? "session" : "run";
}

async function cleanupUntrackedAcpSession(sessionKey: string): Promise<void> {
  const key = sessionKey.trim();
  if (!key) {
    return;
  }
  try {
    await callGateway({
      method: "sessions.delete",
      params: {
        key,
        deleteTranscript: true,
        emitLifecycleHooks: false,
      },
      timeoutMs: 10_000,
    });
  } catch {
    // Best-effort cleanup only.
  }
}

function createSessionsSpawnToolSchema(params: { acpAvailable: boolean }) {
  const schema = {
    task: Type.String(),
    label: Type.Optional(Type.String()),
    runtime: optionalStringEnum(
      params.acpAvailable ? SESSIONS_SPAWN_RUNTIMES : (["subagent"] as const),
    ),
    agentId: Type.Optional(Type.String()),
    model: Type.Optional(Type.String()),
    thinking: Type.Optional(Type.String()),
    workflow: optionalStringEnum(SESSIONS_SPAWN_WORKFLOWS),
    workspaceDir: Type.Optional(Type.String()),
    changedFiles: Type.Optional(Type.Array(Type.String())),
    regulatoryPackagePath: Type.Optional(Type.String()),
    cwd: Type.Optional(Type.String()),
    runTimeoutSeconds: Type.Optional(Type.Number({ minimum: 0 })),
    // Back-compat: older callers used timeoutSeconds for this tool.
    timeoutSeconds: Type.Optional(Type.Number({ minimum: 0 })),
    thread: Type.Optional(Type.Boolean()),
    mode: optionalStringEnum(SUBAGENT_SPAWN_MODES),
    cleanup: optionalStringEnum(["delete", "keep"] as const),
    sandbox: optionalStringEnum(SESSIONS_SPAWN_SANDBOX_MODES),
    context: optionalStringEnum(SUBAGENT_SPAWN_CONTEXT_MODES, {
      description:
        'Native subagent context mode. Omit or use "isolated" for a clean child session; use "fork" only when the child needs the requester transcript context.',
    }),
    lightContext: Type.Optional(
      Type.Boolean({
        description:
          "When true, spawned subagent runs use lightweight bootstrap context. Only applies to runtime='subagent'.",
      }),
    ),

    // Inline attachments (snapshot-by-value).
    // NOTE: Attachment contents are redacted from transcript persistence by sanitizeToolCallInputs.
    attachments: Type.Optional(
      Type.Array(
        Type.Object({
          name: Type.String(),
          content: Type.String(),
          encoding: Type.Optional(optionalStringEnum(["utf8", "base64"] as const)),
          mimeType: Type.Optional(Type.String()),
        }),
        { maxItems: 50 },
      ),
    ),
    attachAs: Type.Optional(
      Type.Object({
        // Where the spawned agent should look for attachments.
        // Kept as a hint; implementation materializes into the child workspace.
        mountPath: Type.Optional(Type.String()),
      }),
    ),
    ...(params.acpAvailable
      ? {
          resumeSessionId: Type.Optional(
            Type.String({
              description:
                'ACP-only resume target. Only meaningful with runtime="acp"; ignored for runtime="subagent". Use only an ACP/harness session ID already recorded for this requester so the ACP backend replays conversation history instead of starting fresh.',
            }),
          ),
          streamTo: optionalStringEnum(SESSIONS_SPAWN_ACP_STREAM_TARGETS, {
            description:
              'ACP-only stream target. Only meaningful with runtime="acp"; ignored for runtime="subagent". Use "parent" to stream the ACP turn back to the requester instead of tracking it as a background sessions_spawn run.',
          }),
        }
      : {}),
  };
  return Type.Object(schema);
}

function resolveAcpUnavailableMessage(opts?: { sandboxed?: boolean; config?: OpenClawConfig }) {
  if (opts?.sandboxed === true) {
    return 'runtime="acp" is unavailable from sandboxed sessions because ACP sessions run on the host. Use runtime="subagent".';
  }
  if (opts?.config?.acp?.enabled === false) {
    return 'runtime="acp" is unavailable because ACP is disabled by policy (`acp.enabled=false`). Use runtime="subagent".';
  }
  return 'runtime="acp" is unavailable in this session because no ACP runtime backend is loaded. Enable the acpx plugin or use runtime="subagent".';
}

export function createSessionsSpawnTool(
  opts?: {
    agentSessionKey?: string;
    agentChannel?: GatewayMessageChannel;
    agentAccountId?: string;
    agentTo?: string;
    agentThreadId?: string | number;
    sandboxed?: boolean;
    config?: OpenClawConfig;
    /** Explicit agent ID override for cron/hook sessions where session key parsing may not work. */
    requesterAgentIdOverride?: string;
    /** Test seam for the coding fan-out runner. */
    codingFanoutRunner?: (options: CodingFanoutOptions) => Promise<CodingFanoutResult>;
  } & SpawnedToolContext,
): AnyAgentTool {
  const acpAvailable = isAcpRuntimeSpawnAvailable({
    config: opts?.config,
    sandboxed: opts?.sandboxed,
  });
  return {
    label: "Sessions",
    name: "sessions_spawn",
    displaySummary: acpAvailable
      ? SESSIONS_SPAWN_TOOL_DISPLAY_SUMMARY
      : SESSIONS_SPAWN_SUBAGENT_TOOL_DISPLAY_SUMMARY,
    description: describeSessionsSpawnTool({ acpAvailable }),
    parameters: createSessionsSpawnToolSchema({ acpAvailable }),
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const unsupportedParam = UNSUPPORTED_SESSIONS_SPAWN_PARAM_KEYS.find((key) =>
        Object.hasOwn(params, key),
      );
      if (unsupportedParam) {
        throw new ToolInputError(
          `sessions_spawn does not support "${unsupportedParam}". Use "message" or "sessions_send" for channel delivery.`,
        );
      }
      const task = readStringParam(params, "task", { required: true });
      const label = readStringParam(params, "label") ?? "";
      const runtime = params.runtime === "acp" ? "acp" : "subagent";
      const requestedAgentId = readStringParam(params, "agentId");
      const resumeSessionId = readStringParam(params, "resumeSessionId");
      const modelOverride = readStringParam(params, "model");
      const thinkingOverrideRaw = readStringParam(params, "thinking");
      const cwd = readStringParam(params, "cwd");
      const mode = params.mode === "run" || params.mode === "session" ? params.mode : undefined;
      const cleanup =
        params.cleanup === "keep" || params.cleanup === "delete" ? params.cleanup : "keep";
      const expectsCompletionMessage = params.expectsCompletionMessage !== false;
      const sandbox = params.sandbox === "require" ? "require" : "inherit";
      const context =
        params.context === "fork" || params.context === "isolated" ? params.context : undefined;
      const streamTo = params.streamTo === "parent" ? "parent" : undefined;
      const lightContext = params.lightContext === true;
      const roleContext = requestedAgentId ? { role: requestedAgentId } : {};
      if (runtime === "acp" && !acpAvailable) {
        return jsonResult({
          status: "error",
          error: resolveAcpUnavailableMessage(opts),
          ...roleContext,
        });
      }
      if (runtime === "acp" && lightContext) {
        throw new Error("lightContext is only supported for runtime='subagent'.");
      }
      if (runtime === "acp" && context === "fork") {
        throw new Error('context="fork" is only supported for runtime="subagent".');
      }
      // Back-compat: older callers used timeoutSeconds for this tool.
      const timeoutSecondsCandidate =
        typeof params.runTimeoutSeconds === "number"
          ? params.runTimeoutSeconds
          : typeof params.timeoutSeconds === "number"
            ? params.timeoutSeconds
            : undefined;
      const runTimeoutSeconds =
        typeof timeoutSecondsCandidate === "number" && Number.isFinite(timeoutSecondsCandidate)
          ? Math.max(0, Math.floor(timeoutSecondsCandidate))
          : undefined;
      const thread = params.thread === true;
      const attachments = Array.isArray(params.attachments)
        ? (params.attachments as Array<{
            name: string;
            content: string;
            encoding?: "utf8" | "base64";
            mimeType?: string;
          }>)
        : undefined;

      if (runtime === "subagent") {
        const cfg = opts?.config ?? getRuntimeConfig();
        const { mainKey, alias } = resolveMainSessionAlias(cfg);
        const requesterInternalKey = opts?.agentSessionKey
          ? resolveInternalSessionKey({
              key: opts.agentSessionKey,
              alias,
              mainKey,
            })
          : alias;
        const requesterOrigin = normalizeDeliveryContext({
          channel: opts?.agentChannel,
          accountId: opts?.agentAccountId,
          to: opts?.agentTo,
          threadId: opts?.agentThreadId,
        });
        const parsedRequesterAgentId = opts?.agentSessionKey
          ? parseAgentSessionKey(opts.agentSessionKey)?.agentId
          : undefined;
        const targetAgentId = normalizeAgentId(
          requestedAgentId ??
            opts?.requesterAgentIdOverride ??
            parsedRequesterAgentId ??
            resolveDefaultAgentId(cfg),
        );
        const targetAgentConfig = resolveAgentConfig(cfg, targetAgentId);
        const spawnWorkflow = resolveSpawnWorkflow({
          requested: normalizeWorkflow(params.workflow),
          targetAgentWorkflow: normalizeWorkflow(targetAgentConfig?.subagents?.workflow),
          defaultWorkflow: normalizeWorkflow(cfg.agents?.defaults?.subagents?.workflow),
          task,
          hasExplicitModelOrThinking: Boolean(modelOverride || thinkingOverrideRaw),
        });

        if (spawnWorkflow === "coding-fanout") {
          const fanoutRunId = `fanout-${crypto.randomUUID()}`;
          const workspaceDir = resolveCodingFanoutWorkspace({
            requestedWorkspace: readStringParam(params, "workspaceDir"),
            targetAgentWorkspace: resolveAgentWorkspaceDir(cfg, targetAgentId),
            defaultWorkspace: cfg.agents?.defaults?.workspace,
          });
          const workObject = createWorkObject({
            kind: "subagent",
            title: label || task.slice(0, 120) || "Coding fan-out task",
            goal: task,
            status: "queued",
            source: {
              type: "sessions_spawn",
              id: fanoutRunId,
              label: label || undefined,
            },
            actor: {
              agentId: targetAgentId,
              runId: fanoutRunId,
              workerId: "codex-clawd-gemini",
            },
            requester: {
              sessionKey: requesterInternalKey,
              channel: requesterOrigin?.channel,
              accountId: requesterOrigin?.accountId,
              to: requesterOrigin?.to,
              threadId:
                requesterOrigin?.threadId != null ? String(requesterOrigin.threadId) : undefined,
            },
            isolation: {
              workspace: workspaceDir,
            },
            recovery: {
              policy: "manual",
            },
            evidence: [
              {
                kind: "text",
                label: "Coding fan-out accepted",
                value: "OpenClaw routed this coding task to Codex, Clawd, and Gemini.",
              },
            ],
          });
          const defaultFanout = cfg.agents?.defaults?.subagents?.codingFanout;
          const agentFanout = targetAgentConfig?.subagents?.codingFanout;
          const fanout = { ...defaultFanout, ...agentFanout };
          const timeoutSeconds =
            runTimeoutSeconds && runTimeoutSeconds > 0
              ? runTimeoutSeconds
              : (fanout.timeoutSeconds ?? undefined);
          const runner = opts?.codingFanoutRunner ?? runCodingFanout;
          void runner({
            workObjectId: workObject.id,
            workspaceDir: resolveUserPath(workspaceDir),
            task,
            changedFiles: readStringArrayParam(params, "changedFiles"),
            timeoutMs: timeoutSeconds ? timeoutSeconds * 1000 : undefined,
            codexModel: fanout.codexModel,
            claudeModel: fanout.claudeModel,
            geminiModel: fanout.geminiModel,
            regulatoryPackagePath: readStringParam(params, "regulatoryPackagePath"),
          })
            .then((result) =>
              announceCodingFanoutResult({
                requesterSessionKey: requesterInternalKey,
                requesterOrigin,
                task,
                label: label || undefined,
                result,
              }),
            )
            .catch((err) => {
              const messageText = summarizeError(err);
              const workObjectResult = completeWorkObject({
                id: workObject.id,
                status: "failed",
                summary: "Coding fan-out crashed before completion.",
                output: messageText,
              });
              void announceCodingFanoutResult({
                requesterSessionKey: requesterInternalKey,
                requesterOrigin,
                task,
                label: label || undefined,
                result: {
                  workObject: workObjectResult,
                  status: "failed",
                  policySatisfied: false,
                  missingRoles: [],
                  failedRoles: ["implementer", "reviewer", "verifier"],
                },
              });
            });

          return jsonResult({
            status: "accepted",
            workflow: "coding-fanout",
            runId: fanoutRunId,
            workObjectId: workObject.id,
            workspaceDir,
            ...roleContext,
          });
        }
      }

      if (runtime === "acp") {
        const { isSpawnAcpAcceptedResult, spawnAcpDirect } = await loadAcpSpawnModule();
        if (Array.isArray(attachments) && attachments.length > 0) {
          return jsonResult({
            status: "error",
            error:
              "attachments are currently unsupported for runtime=acp; use runtime=subagent or remove attachments",
            ...roleContext,
          });
        }
        const result = await spawnAcpDirect(
          {
            task,
            label: label || undefined,
            agentId: requestedAgentId,
            resumeSessionId,
            model: modelOverride,
            thinking: thinkingOverrideRaw,
            runTimeoutSeconds,
            cwd,
            mode: mode === "run" || mode === "session" ? mode : undefined,
            thread,
            sandbox,
            streamTo,
          },
          {
            agentSessionKey: opts?.agentSessionKey,
            agentChannel: opts?.agentChannel,
            agentAccountId: opts?.agentAccountId,
            agentTo: opts?.agentTo,
            agentThreadId: opts?.agentThreadId,
            agentGroupId: opts?.agentGroupId ?? undefined,
            agentGroupSpace: opts?.agentGroupSpace,
            agentMemberRoleIds: opts?.agentMemberRoleIds,
            sandboxed: opts?.sandboxed,
          },
        );
        const childSessionKey = result.childSessionKey?.trim();
        const childRunId = isSpawnAcpAcceptedResult(result) ? result.runId?.trim() : undefined;
        const shouldTrackViaRegistry =
          result.status === "accepted" &&
          Boolean(childSessionKey) &&
          Boolean(childRunId) &&
          streamTo !== "parent";
        if (shouldTrackViaRegistry && childSessionKey && childRunId) {
          const cfg = getRuntimeConfig();
          const trackedSpawnMode = resolveTrackedSpawnMode({
            requestedMode: result.mode,
            threadRequested: thread,
          });
          const trackedCleanup = trackedSpawnMode === "session" ? "keep" : cleanup;
          const { mainKey, alias } = resolveMainSessionAlias(cfg);
          const requesterInternalKey = opts?.agentSessionKey
            ? resolveInternalSessionKey({
                key: opts.agentSessionKey,
                alias,
                mainKey,
              })
            : alias;
          const requesterDisplayKey = resolveDisplaySessionKey({
            key: requesterInternalKey,
            alias,
            mainKey,
          });
          const requesterOrigin = normalizeDeliveryContext({
            channel: opts?.agentChannel,
            accountId: opts?.agentAccountId,
            to: opts?.agentTo,
            threadId: opts?.agentThreadId,
          });
          try {
            registerSubagentRun({
              runId: childRunId,
              childSessionKey,
              requesterSessionKey: requesterInternalKey,
              requesterOrigin,
              requesterDisplayKey,
              task,
              cleanup: trackedCleanup,
              label: label || undefined,
              runTimeoutSeconds,
              expectsCompletionMessage,
              spawnMode: trackedSpawnMode,
            });
          } catch (err) {
            // Best-effort only: the ACP turn was already started above, so deleting the
            // child session record here does not guarantee the in-flight run was aborted.
            await cleanupUntrackedAcpSession(childSessionKey);
            return jsonResult({
              status: "error",
              error: `Failed to register ACP run: ${summarizeError(err)}. Cleanup was attempted, but the already-started ACP run may still finish in the background.`,
              childSessionKey,
              runId: childRunId,
              ...roleContext,
            });
          }
        }
        return jsonResult(addRoleToFailureResult(result, requestedAgentId));
      }

      const result = await spawnSubagentDirect(
        {
          task,
          label: label || undefined,
          agentId: requestedAgentId,
          model: modelOverride,
          thinking: thinkingOverrideRaw,
          runTimeoutSeconds,
          thread,
          mode,
          cleanup,
          sandbox,
          context,
          lightContext,
          expectsCompletionMessage,
          attachments,
          attachMountPath:
            params.attachAs && typeof params.attachAs === "object"
              ? readStringParam(params.attachAs as Record<string, unknown>, "mountPath")
              : undefined,
        },
        {
          agentSessionKey: opts?.agentSessionKey,
          agentChannel: opts?.agentChannel,
          agentAccountId: opts?.agentAccountId,
          agentTo: opts?.agentTo,
          agentThreadId: opts?.agentThreadId,
          agentGroupId: opts?.agentGroupId,
          agentGroupChannel: opts?.agentGroupChannel,
          agentGroupSpace: opts?.agentGroupSpace,
          agentMemberRoleIds: opts?.agentMemberRoleIds,
          requesterAgentIdOverride: opts?.requesterAgentIdOverride,
          workspaceDir: opts?.workspaceDir,
        },
      );

      return jsonResult(addRoleToFailureResult(result, requestedAgentId));
    },
  };
}
