import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { Type } from "typebox";
import { getRuntimeConfig } from "../../config/config.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { CronAuthenticatedChannelRequester } from "../../gateway/cron-creator-authority-grant.types.js";
import { resolveHeartbeatConfig } from "../../infra/heartbeat-config.js";
import {
  isHeartbeatQuestionModeActive,
  parseHeartbeatQuestionDocument,
  removeHeartbeatQuestionGroup,
  serializeHeartbeatQuestionDocument,
  upsertHeartbeatQuestionGroup,
} from "../../infra/heartbeat-questions.js";
import type { OpenClawToolsOptions } from "../openclaw-tools.types.js";
import { resolveScheduledToolPolicyContext } from "../scheduled-tool-policy.js";
import { stringEnum } from "../schema/string-enum.js";
import { type AnyAgentTool, jsonResult, readToolStringParam, ToolInputError } from "./common.js";
import {
  isCronCreatorToolCaptureComplete,
  resolveCronCreatorExecToolTarget,
} from "./cron-tool-creator-cap.js";
import {
  captureGatewayToolCallerAssertion,
  getGatewayToolCallerIdentity,
} from "./gateway-caller-context.js";

export function createHeartbeatTools(
  agentId: string,
  config: OpenClawConfig | undefined,
  options: OpenClawToolsOptions | undefined,
  embedded: boolean,
): AnyAgentTool[] {
  const cfg = config ?? getRuntimeConfig();
  return !options?.sandboxed &&
    !embedded &&
    isHeartbeatQuestionModeActive(cfg, agentId, resolveHeartbeatConfig(cfg, agentId))
    ? [createHeartbeatQuestionsTool(agentId, options)]
    : [];
}

function createHeartbeatQuestionsTool(
  sessionAgentId: string,
  options?: OpenClawToolsOptions,
): AnyAgentTool {
  return {
    name: "heartbeat_questions",
    label: "Heartbeat questions",
    description:
      "List, upsert, or remove experimental heartbeat groups. Each group has 1–5 observational shell commands and 1–32 yes/no questions. Commands run under existing exec policy; that group's output plus recent conversation and heartbeat notes becomes its decision-model state. Any yes wakes the full agent; all no skips it. Keep complete group requests under 24KiB: filter output or split groups. Failures wake the agent. Upsert replaces the whole group by id. Do not put secrets or action commands in context collection. Existing notes are preserved.",
    parameters: Type.Object(
      {
        action: stringEnum(["list", "upsert", "remove"]),
        id: Type.Optional(Type.String({ pattern: "^[a-zA-Z0-9_-]{1,64}$" })),
        commands: Type.Optional(
          Type.Array(Type.String({ minLength: 1, maxLength: 4000 }), { minItems: 1, maxItems: 5 }),
        ),
        questions: Type.Optional(
          Type.Array(
            Type.Object(
              {
                id: Type.String({ pattern: "^[a-zA-Z0-9_-]{1,64}$" }),
                question: Type.String({ minLength: 1, maxLength: 2000 }),
              },
              { additionalProperties: false },
            ),
            { minItems: 1, maxItems: 32 },
          ),
        ),
      },
      { additionalProperties: false },
    ),
    async execute(_callId, args, signal) {
      if (!isRecord(args)) {
        throw new ToolInputError("Heartbeat question arguments required.");
      }
      const action = readToolStringParam(args, "action", { required: true });
      if (action !== "list" && action !== "upsert" && action !== "remove") {
        throw new ToolInputError("Choose list, upsert, or remove.");
      }
      const assertAuthority = captureGatewayToolCallerAssertion();
      if (!assertAuthority || getGatewayToolCallerIdentity()?.agentId !== sessionAgentId) {
        throw new Error("Heartbeat questions require the owning agent's active run authority.");
      }
      signal?.throwIfAborted();
      assertAuthority();
      const [
        { writeCronJobScratch },
        { resolveCronJobsStorePathFromConfig },
        { readCronScratchSnapshot },
      ] = await Promise.all([
        import("../../cron/scratch-store.js"),
        import("../../cron/store.js"),
        import("../../cron/scratch-read.js"),
      ]);
      signal?.throwIfAborted();
      assertAuthority();
      const config = getRuntimeConfig();
      if (
        !isHeartbeatQuestionModeActive(
          config,
          sessionAgentId,
          resolveHeartbeatConfig(config, sessionAgentId),
        )
      ) {
        throw new Error(
          "Experimental heartbeat question mode needs heartbeat.mode questions, Decision assistance, and a decisionModel for this agent.",
        );
      }
      const storePath = resolveCronJobsStorePathFromConfig(config);
      const monitor = await readCronScratchSnapshot(
        storePath,
        { kind: "heartbeat", agentId: sessionAgentId },
        {},
        { assertCurrent: assertAuthority, signal },
      );
      signal?.throwIfAborted();
      assertAuthority();
      if (getRuntimeConfig() !== config) {
        throw new Error("Heartbeat configuration changed. Retry from a current agent turn.");
      }
      if (!monitor) {
        throw new Error(
          "Heartbeat monitor is missing. Enable Cron and this agent's heartbeat, then start the Gateway or run openclaw doctor to reconcile monitors.",
        );
      }
      const parsed = parseHeartbeatQuestionDocument(monitor.state.scratch?.content);
      if (parsed.status === "invalid") {
        throw new Error(parsed.error);
      }
      if (action === "list") {
        return jsonResult({
          groups: parsed.document.groups.map(({ execution: _execution, ...group }) => group),
          revision: monitor.state.currentRevision,
        });
      }
      const id = readToolStringParam(args, "id", { required: true });
      let document = parsed.document;
      if (action === "upsert") {
        const caller = getGatewayToolCallerIdentity();
        const resolved = await options?.resolveCronCreatorToolAuthority?.({ signal });
        signal?.throwIfAborted();
        assertAuthority();
        let channelRequester: CronAuthenticatedChannelRequester | undefined;
        if (resolved) {
          const { consumeCronCreatorAuthorityGrant, resolveCronCreatorAuthorityGrantProvenance } =
            await import("../../gateway/cron-creator-authority-grant.js");
          signal?.throwIfAborted();
          assertAuthority();
          const runId = caller?.operationalRunInstance?.runId;
          channelRequester = runId
            ? resolveCronCreatorAuthorityGrantProvenance(resolved.grant, runId)?.channelRequester
            : undefined;
          consumeCronCreatorAuthorityGrant(resolved.grant);
        }
        const tools = resolved?.tools ?? options?.cronCreatorToolAllowlist;
        if (
          (!resolved &&
            !isCronCreatorToolCaptureComplete(options?.cronCreatorToolAllowlistCaptureRef)) ||
          !tools?.some((entry) => (typeof entry === "string" ? entry : entry.name) === "exec")
        ) {
          throw new Error(
            "Saving heartbeat commands requires exec in this turn's final authorized tool surface.",
          );
        }
        caller?.assertToolAllowed?.("exec");
        const execTarget = resolveCronCreatorExecToolTarget(tools);
        const scheduledToolPolicy = resolveScheduledToolPolicyContext({
          toolsAllow: ["exec"],
          scheduledToolPolicy: caller?.turnSourceLocal
            ? { version: 1, mode: "trusted" }
            : {
                version: 1,
                mode: "account",
                ownerSessionKey: caller?.sessionKey,
                ownerAccountId: caller?.turnSourceAccountId,
              },
          callerOrigin: caller?.turnSourceLocal
            ? { kind: "local" }
            : caller?.turnSourceChannel
              ? {
                  kind: "external",
                  channel: caller.turnSourceChannel,
                }
              : { kind: "unknown" },
          execTarget,
        });
        if (!scheduledToolPolicy) {
          throw new Error(
            "Heartbeat commands require an authenticated local or account-scoped creator turn.",
          );
        }
        // Chat-created groups keep their owner sender so each scheduled run can recheck ownership.
        if (
          scheduledToolPolicy.mode === "account" &&
          channelRequester?.accountId !== scheduledToolPolicy.ownerAccountId
        ) {
          throw new Error(
            "Saving heartbeat commands from a chat requires the channel's configured command owner.",
          );
        }
        if (
          !Array.isArray(args.commands) ||
          !args.commands.every((command) => typeof command === "string") ||
          !Array.isArray(args.questions) ||
          !args.questions.every(
            (question) =>
              isRecord(question) &&
              typeof question.id === "string" &&
              typeof question.question === "string",
          )
        ) {
          throw new ToolInputError("Provide commands and questions for the whole group.");
        }
        document = upsertHeartbeatQuestionGroup(document, {
          id,
          commands: args.commands,
          questions: args.questions.map((question) => ({
            id: String(question.id),
            question: String(question.question),
          })),
          execution: {
            toolsAllow: ["exec"],
            scheduledToolPolicy,
            ...(scheduledToolPolicy.mode === "account" ? { channelRequester } : {}),
          },
        });
      } else {
        document = removeHeartbeatQuestionGroup(document, id);
      }
      const content = serializeHeartbeatQuestionDocument(document);
      signal?.throwIfAborted();
      assertAuthority();
      if (getRuntimeConfig() !== config) {
        throw new Error("Heartbeat configuration changed. Retry from a current agent turn.");
      }
      const result = await writeCronJobScratch(
        {
          storePath,
          jobId: monitor.jobId,
          expectedRevision: monitor.state.currentRevision,
          content,
        },
        {
          assertCurrent() {
            signal?.throwIfAborted();
            assertAuthority();
            if (getRuntimeConfig() !== config) {
              throw new Error("Heartbeat configuration changed. Retry from a current agent turn.");
            }
          },
        },
      );
      if (!result.ok) {
        throw new Error(
          "Heartbeat questions changed concurrently. List current questions and retry.",
        );
      }
      return jsonResult({
        groups: document.groups.map(({ execution: _execution, ...group }) => group),
        revision: result.currentRevision,
      });
    },
  };
}
