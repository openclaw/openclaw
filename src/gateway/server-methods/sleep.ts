import { randomUUID } from "node:crypto";
import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import { scheduleSessionSleep } from "../../infra/session-sleep.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import { formatForLog } from "../ws-log.js";
import { agentRunHandler } from "./agent-run-handler.js";
import type { GatewayClient, GatewayRequestHandlers } from "./types.js";

const MAX_SLEEP_SECONDS = 600;
const SLEEP_SCHEDULE_PARAM_KEYS = new Set(["seconds", "message", "sessionKey", "toolsAllow"]);

type SleepScheduleParams = {
  seconds: number;
  message: string;
  sessionKey: string;
  toolsAllow?: string[];
};

function readSleepScheduleParams(value: Record<string, unknown>): SleepScheduleParams | undefined {
  const seconds = value.seconds;
  const message = typeof value.message === "string" ? value.message.trim() : "";
  const sessionKey = typeof value.sessionKey === "string" ? value.sessionKey.trim() : "";
  const toolsAllow = value.toolsAllow;
  if (
    !Object.keys(value).every((key) => SLEEP_SCHEDULE_PARAM_KEYS.has(key)) ||
    typeof seconds !== "number" ||
    !Number.isInteger(seconds) ||
    seconds < 1 ||
    seconds > MAX_SLEEP_SECONDS ||
    !message ||
    !sessionKey ||
    (toolsAllow !== undefined &&
      (!Array.isArray(toolsAllow) ||
        toolsAllow.some((entry) => typeof entry !== "string" || !entry.trim())))
  ) {
    return undefined;
  }
  return {
    seconds,
    message,
    sessionKey,
    ...(toolsAllow === undefined ? {} : { toolsAllow: toolsAllow.map((entry) => entry.trim()) }),
  };
}

/** Agent-only RPC for restart-ephemeral, same-session wake scheduling. */
export const sleepHandlers: GatewayRequestHandlers = {
  "sleep.schedule": ({ req, params, respond, context, client, isWebchatConnect }) => {
    const request = readSleepScheduleParams(params);
    if (!request) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid sleep.schedule params: seconds must be 1-${MAX_SLEEP_SECONDS}; message and sessionKey are required`,
        ),
      );
      return;
    }
    const caller = client;
    const identity = caller?.internal?.agentRuntimeIdentity;
    if (!caller || !identity?.sessionKey || identity.sessionKey.trim() !== request.sessionKey) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          "sleep.schedule requires a matching agent runtime session identity",
        ),
      );
      return;
    }

    const wakeId = randomUUID();
    const agentParams = {
      message: request.message,
      agentId: normalizeAgentId(identity.agentId),
      sessionKey: request.sessionKey,
      deliver: true,
      inputProvenance: {
        kind: "internal_system" as const,
        sourceSessionKey: request.sessionKey,
        sourceTool: "sleep",
      },
      idempotencyKey: `sleep:${wakeId}`,
    };
    const wakeClient: GatewayClient = {
      ...caller,
      internal: {
        ...caller.internal,
        ...(request.toolsAllow ? { sleepToolsAllow: request.toolsAllow } : {}),
      },
    };
    const wakeAtMs = Date.now() + request.seconds * 1_000;
    scheduleSessionSleep({
      sessionKey: request.sessionKey,
      delayMs: request.seconds * 1_000,
      onWake: async () => {
        await agentRunHandler({
          req: { ...req, id: wakeId, method: "agent", params: agentParams },
          params: agentParams,
          client: wakeClient,
          context,
          isWebchatConnect,
          respond: (ok, _payload, error) => {
            if (!ok) {
              context.logGateway.error(
                `sleep wake failed for ${request.sessionKey}: ${error?.message ?? "unknown error"}`,
              );
            }
          },
        });
      },
      onError: (error) => {
        context.logGateway.error(
          `sleep wake failed for ${request.sessionKey}: ${formatForLog(error)}`,
        );
      },
    });
    respond(true, {
      ok: true,
      sessionKey: request.sessionKey,
      wakeAtMs,
    });
  },
};
