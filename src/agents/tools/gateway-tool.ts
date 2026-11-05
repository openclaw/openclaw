import {
  asOptionalObjectRecord,
  asOptionalRecord,
} from "@openclaw/normalization-core/record-coerce";
import { readStringValue } from "@openclaw/normalization-core/string-coerce";
import { Type } from "typebox";
import { prepareCommandOwnerAuthority } from "../../auto-reply/command-auth.js";
import { formatCommandOwnerHint } from "../../commands/doctor-command-owner.js";
import { GatewayClientRequestError } from "../../gateway/client.js";
import {
  DEFAULT_UPDATE_TIMEOUT_MS,
  summarizeUpdateRunResponse,
} from "../../gateway/update-run-summary.js";
import { captureGatewayStateOwner } from "../../infra/gateway-state-owner.js";
import { parseConfigPathArrayIndex } from "../../shared/path-array-index.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { isInternalMessageChannel } from "../../utils/message-channel.js";
import { getAdmittedRunSource } from "../admitted-run-context.js";
import { stringEnum } from "../schema/typebox.js";
import {
  type AnyAgentTool,
  jsonResult,
  readToolStringParam,
  textResult,
  ToolInputError,
} from "./common.js";
import { getGatewayToolCallerIdentity } from "./gateway-caller-context.js";
import { gatewayCallOptionSchemaProperties } from "./gateway-schema.js";
import { callGatewayTool, readGatewayCallOptions } from "./gateway.js";
import { callInProcessGatewayTool, getInProcessGatewayToolContext } from "./in-process-gateway.js";

// Keep complete JSON below the smallest default tool-result presentation budget.
const MAX_GATEWAY_CONFIG_GET_TEXT_CHARS = 12_000;
const CONFIG_SCHEMA_PATH_NOT_FOUND_MESSAGE = "config schema path not found";

function resolveGatewayConfigGetPath(config: Record<string, unknown>, path: string): unknown {
  const parts = path
    .trim()
    .replace(/\[(\d+)\]/g, ".$1")
    .split(".")
    .filter(Boolean);
  if (parts.length === 0) {
    return undefined;
  }
  let current: unknown = config;
  for (const part of parts) {
    if (!current || typeof current !== "object") {
      return undefined;
    }
    if (Array.isArray(current)) {
      const index = parseConfigPathArrayIndex(part);
      if (index === undefined || index >= current.length) {
        return undefined;
      }
      current = current[index];
      continue;
    }
    if (!Object.hasOwn(current, part)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function isConfigSchemaPathNotFoundError(error: unknown): boolean {
  return (
    error instanceof GatewayClientRequestError &&
    error.gatewayCode === "INVALID_REQUEST" &&
    error.message.includes(CONFIG_SCHEMA_PATH_NOT_FOUND_MESSAGE)
  );
}

const MAINTENANCE_ACTIONS = ["update.run", "restart", "update.cleanup"] as const;
const GATEWAY_ACTIONS = ["config.get", "config.schema.lookup", ...MAINTENANCE_ACTIONS] as const;

const GatewayToolSchema = Type.Object({
  action: stringEnum(GATEWAY_ACTIONS),
  ...gatewayCallOptionSchemaProperties(),
  note: Type.Optional(
    Type.String({ description: "Short human note for the update or post-restart notice." }),
  ),
  dryRun: Type.Optional(
    Type.Boolean({ description: "update.cleanup only: preview without removing recovery copies." }),
  ),
  path: Type.Optional(
    Type.String({
      description: "Required for config.schema.lookup; optional for config.get.",
    }),
  ),
});

const GatewayUpdateToolSchema = Type.Object({
  action: stringEnum(MAINTENANCE_ACTIONS),
  note: GatewayToolSchema.properties.note,
  dryRun: GatewayToolSchema.properties.dryRun,
});

export function createGatewayTool(options?: {
  allowConfigReads?: boolean;
  senderIsOwner?: boolean;
  requesterSenderId?: string | null;
}): AnyAgentTool {
  const allowConfigReads = options?.allowConfigReads !== false;
  return {
    label: "Gateway",
    name: "gateway",
    description: allowConfigReads
      ? "Read gateway config/schema. Owner request/operator schedule: update.run, restart, update.cleanup. Use runtime-owned actions."
      : "Owner request/operator schedule: update.run, restart, update.cleanup. Cleanup permanently retires eligible rollback copies; dryRun previews. Use runtime-owned actions.",
    parameters: allowConfigReads ? GatewayToolSchema : GatewayUpdateToolSchema,
    execute: async (_toolCallId, args, signal) => {
      const params = args as Record<string, unknown>;
      const action = readToolStringParam(params, "action", { required: true });
      if (action === "update.run" || action === "restart" || action === "update.cleanup") {
        const caller = getGatewayToolCallerIdentity();
        const operatorSchedule =
          !options?.requesterSenderId &&
          getAdmittedRunSource(caller?.approvalAuthority) === "operator-schedule";
        if (options?.senderIsOwner !== true && !operatorSchedule) {
          const hint = formatCommandOwnerHint({
            channel: caller?.turnSourceChannel,
            id: options?.requesterSenderId,
          });
          return jsonResult({
            ok: false,
            code: "owner_required",
            reason: "owner_required",
            message: `No authenticated owner chat principal or operator-scheduled admission authorizes this update. ${hint}`,
          });
        }
        if (action !== "update.run") {
          const context = getInProcessGatewayToolContext();
          if (!context) {
            throw new Error(`Gateway instance unavailable for ${action}`);
          }
          const channel = caller?.turnSourceChannel;
          const chat =
            action === "update.cleanup" &&
            !operatorSchedule &&
            channel &&
            !isInternalMessageChannel(channel);
          const authority = chat
            ? await prepareCommandOwnerAuthority(context.getRuntimeConfig(), {
                channel,
                accountId: caller?.turnSourceAccountId,
                senderId: options?.requesterSenderId ?? undefined,
              })
            : undefined;
          const assertCurrent = () => {
            if (chat && !authority?.isCurrent(context.getRuntimeConfig())) {
              throw new Error("Gateway maintenance requires a current owner principal.");
            }
          };
          assertCurrent();
          const owner =
            action === "update.cleanup"
              ? captureGatewayStateOwner(resolveOpenClawStateSqlitePath())
              : undefined;
          if (action === "update.cleanup" && owner?.role !== "gateway") {
            throw new Error("Gateway does not own the selected state; nothing was removed.");
          }
          const result = await callInProcessGatewayTool(
            action === "restart" ? "gateway.restart.request" : "update.recovery.cleanup",
            action === "restart"
              ? {
                  reason: "gateway.restart.agent",
                  requester: operatorSchedule
                    ? undefined
                    : {
                        channel: caller?.turnSourceChannel,
                        accountId: caller?.turnSourceAccountId,
                        senderId: options?.requesterSenderId ?? undefined,
                      },
                  sessionKey: caller?.sessionKey,
                  deliveryContext: caller
                    ? {
                        channel: caller.turnSourceChannel,
                        to: caller.turnSourceTo,
                        accountId: caller.turnSourceAccountId,
                        threadId: caller.turnSourceThreadId,
                      }
                    : undefined,
                  note: readToolStringParam(params, "note"),
                }
              : { expectedOwnerId: owner!.ownerId, dryRun: params.dryRun === true },
            {
              resolveGatewayContext: getInProcessGatewayToolContext,
              sessionMutationCommitGuard: assertCurrent,
              timeoutMs: DEFAULT_UPDATE_TIMEOUT_MS,
              signal,
            },
          );
          return jsonResult(result);
        }
        // Routing comes from the admitted caller, never model-authored destinations or credentials.
        const deliveryContext = caller
          ? {
              channel: caller.turnSourceChannel,
              to: caller.turnSourceTo,
              accountId: caller.turnSourceAccountId,
              threadId: caller.turnSourceThreadId,
            }
          : undefined;
        const result = await callInProcessGatewayTool(
          "update.run",
          {
            // Scheduled delivery can target a chat without making it the update requester.
            requester: operatorSchedule
              ? undefined
              : {
                  channel: caller?.turnSourceChannel,
                  accountId: caller?.turnSourceAccountId,
                  senderId: options?.requesterSenderId ?? undefined,
                },
            sessionKey: caller?.sessionKey,
            deliveryContext,
            note: readToolStringParam(params, "note"),
          },
          {
            // An explicit binding prevents the standalone client's remote fallback.
            resolveGatewayContext: getInProcessGatewayToolContext,
            timeoutMs: DEFAULT_UPDATE_TIMEOUT_MS,
            signal,
          },
        );
        return jsonResult(summarizeUpdateRunResponse(result));
      }
      if (!allowConfigReads) {
        throw new ToolInputError(`Action not available: ${action}`);
      }
      const gatewayOpts = readGatewayCallOptions(params);
      const callConfigGateway = (method: string, requestParams: Record<string, unknown>) =>
        callGatewayTool(method, gatewayOpts, requestParams, { signal });

      if (action === "config.get") {
        const path = readToolStringParam(params, "path");
        const snapshot = await callConfigGateway("config.get", {});
        let result = snapshot;
        if (path) {
          const record = asOptionalObjectRecord(snapshot);
          if (!record) {
            throw new Error("config.get response is not an object.");
          }
          const config = asOptionalRecord(record.config);
          if (!config) {
            throw new Error("config.get response is missing a config object.");
          }
          const value = resolveGatewayConfigGetPath(config, path);
          if (value === undefined) {
            throw new ToolInputError(`config path not found: ${path}`);
          }
          const hash = readStringValue(record.hash);
          result = { ...(hash ? { hash } : {}), path, config: value };
        }
        const payload = { ok: true, result };
        const text = JSON.stringify(payload, null, 2);
        if (text.length > MAX_GATEWAY_CONFIG_GET_TEXT_CHARS) {
          throw new ToolInputError(
            "config.get response is too large; use path to request a narrower config subtree",
          );
        }
        return textResult(text, payload);
      }
      if (action === "config.schema.lookup") {
        const path = readToolStringParam(params, "path", {
          required: true,
        });
        try {
          const result = await callConfigGateway("config.schema.lookup", { path });
          return jsonResult({ ok: true, result });
        } catch (error) {
          if (isConfigSchemaPathNotFoundError(error)) {
            return jsonResult({
              ok: false,
              code: "schema_path_not_found",
              path,
              message: CONFIG_SCHEMA_PATH_NOT_FOUND_MESSAGE,
            });
          }
          throw error;
        }
      }
      throw new Error(`Unknown action: ${action}`);
    },
  };
}
