import { loadConfig } from "../../config/config.js";
import {
  clearApnsRegistrationIfCurrent,
  loadApnsRegistration,
  normalizeApnsEnvironment,
  resolveApnsAuthConfigFromEnv,
  resolveApnsRelayConfigFromEnv,
  sendApnsAlert,
  shouldClearStoredApnsRegistration,
} from "../../infra/push-apns.js";
import { normalizeStringifiedOptionalString } from "../../shared/string-coerce.js";
import { ErrorCodes, errorShape, validatePushTestParams } from "../protocol/index.js";
import { respondInvalidParams, respondUnavailableOnThrow } from "./nodes.helpers.js";
import { normalizeTrimmedString } from "./record-shared.js";
import type { GatewayRequestHandlers } from "./types.js";

export const pushHandlers: GatewayRequestHandlers = {
  "push.test": async ({ params, respond }) => {
    if (!validatePushTestParams(params)) {
      respondInvalidParams({
        respond,
        method: "push.test",
        validator: validatePushTestParams,
      });
      return;
    }

    const nodeId = normalizeStringifiedOptionalString(params.nodeId) ?? "";
    if (!nodeId) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "nodeId required"));
      return;
    }

    const title = normalizeTrimmedString(params.title) ?? "OpenClaw";
    const body = normalizeTrimmedString(params.body) ?? `Push test for node ${nodeId}`;

    await respondUnavailableOnThrow(respond, async () => {
      const registration = await loadApnsRegistration(nodeId);
      if (!registration) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            `node ${nodeId} has no APNs registration (connect iOS node first)`,
          ),
        );
        return;
      }

      const overrideEnvironment = normalizeApnsEnvironment(params.environment);
      const result =
        registration.transport === "direct"
          ? await (async () => {
              const auth = await resolveApnsAuthConfigFromEnv(process.env);
              if (!auth.ok) {
                respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, auth.error));
                return null;
              }
              return await sendApnsAlert({
                registration: {
                  ...registration,
                  environment: overrideEnvironment ?? registration.environment,
                },
                nodeId,
                title,
                body,
                auth: auth.value,
              });
            })()
          : await (async () => {
              const relay = resolveApnsRelayConfigFromEnv(process.env, loadConfig().gateway);
              if (!relay.ok) {
                respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, relay.error));
                return null;
              }
              return await sendApnsAlert({
                registration,
                nodeId,
                title,
                body,
                relayConfig: relay.value,
              });
            })();
      if (!result) {
        return;
      }
      if (
        shouldClearStoredApnsRegistration({
          registration,
          result,
          overrideEnvironment,
        })
      ) {
        await clearApnsRegistrationIfCurrent({
          nodeId,
          registration,
        });
      }
      respond(true, result, undefined);
    });
  },
};
