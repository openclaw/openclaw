import {
  ErrorCodes,
  errorShape,
  validateUpdateRunParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { resolveOcmUpdateManager } from "../../infra/ocm-update-client.js";
import { normalizeUpdateChannel } from "../../infra/update-channels.js";
import { isInternalMessageChannel } from "../../utils/message-channel.js";
import { readGatewayRequestMutationAuthority } from "./session-mutation-guards.js";
import type { GatewayRequestHandlers } from "./types.js";
import { updateHandlers as nativeUpdateHandlers } from "./update.js";
import { assertValidParams } from "./validation.js";

export const updateHandlers: GatewayRequestHandlers = {
  ...nativeUpdateHandlers,
  "update.run": async (request) => {
    const { params, respond, context } = request;
    const authority = readGatewayRequestMutationAuthority(request);
    if (!assertValidParams(params, validateUpdateRunParams, "update.run", respond)) {
      return;
    }
    const channel = params.requester?.channel;
    // External chat retains the native owner-revalidation and refusal path.
    const manager =
      !channel || isInternalMessageChannel(channel) ? await resolveOcmUpdateManager() : null;
    if (!manager?.canStart) {
      const native = nativeUpdateHandlers["update.run"];
      if (!native) {
        throw new Error("The native update handler is unavailable.");
      }
      return native(request);
    }
    if (params.target) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          "This OCM version does not support an explicit Git update target.",
        ),
      );
      return;
    }
    const run = await manager.start(
      authority.assertCurrent,
      normalizeUpdateChannel(context.getRuntimeConfig().update?.channel),
    );
    respond(true, {
      runId: run.runId,
      ok: run.status === "running" || run.status === "succeeded" || run.status === "skipped",
      result: {
        status:
          run.status === "running" || run.status === "skipped"
            ? "skipped"
            : run.status === "succeeded"
              ? "ok"
              : "error",
        reason: run.reason,
      },
      ...(run.status === "running" ? { handoff: { status: "started" } } : {}),
      message:
        "OCM owns this update. Use the Update status view to follow its progress and result.",
    });
  },
};
