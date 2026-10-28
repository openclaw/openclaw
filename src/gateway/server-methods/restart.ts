import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import {
  ErrorCodes,
  errorShape,
  validateUpdateRunParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { prepareCommandOwnerAuthority } from "../../auto-reply/command-auth.js";
import { isRestartEnabled } from "../../config/commands.flags.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { readActiveGatewayLockIdentity } from "../../infra/gateway-lock.js";
import {
  createSafeGatewayRestartPreflight,
  scheduleSafeGatewayRestart,
} from "../../infra/restart-coordinator.js";
import {
  clearRestartSentinelIfRevision,
  writeRestartSentinel,
} from "../../infra/restart-sentinel.js";
import { requestGatewayRestartWithSignalAdmission } from "../../infra/restart.js";
import { isInternalMessageChannel } from "../../utils/message-channel.js";
import {
  parseRestartRequestParams,
  parseTargetedGatewayRestart,
  parseTargetedGatewayRestartIntent,
} from "./restart-request.js";
import { readGatewayRequestMutationAuthority } from "./session-mutation-guards.js";
import type { GatewayRequestHandlers, RespondFn } from "./types.js";

function normalizeReason(value: unknown): string | undefined {
  // Restart reasons are operator-visible log context, not payload storage.
  // Trim and cap them before passing through to the coordinator.
  return typeof value === "string" && value.trim()
    ? truncateUtf16Safe(value.trim(), 200)
    : undefined;
}

function rejectRestartRequest(respond: RespondFn, message: string): void {
  respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, message));
}

export const restartHandlers: GatewayRequestHandlers = {
  "gateway.stop.request": async (options) => {
    const { params, respond, context } = options;
    const target = isRecord(params) ? parseTargetedGatewayRestart(params.target) : null;
    if (!target) {
      return rejectRestartRequest(respond, "invalid targeted gateway stop");
    }
    const { assertCurrent } = readGatewayRequestMutationAuthority(options);
    try {
      assertCurrent();
      const activeLock = await readActiveGatewayLockIdentity();
      assertCurrent();
      if (
        activeLock?.pid !== process.pid ||
        activeLock.pid !== target.pid ||
        activeLock.ownerId !== target.ownerId ||
        activeLock.port !== target.port
      ) {
        return rejectRestartRequest(respond, "target gateway no longer owns the active lock");
      }
      const result = await context.hostLifecycle?.request("stop", assertCurrent);
      if (!result?.ok) {
        throw new Error(result?.error ?? "Gateway host does not own process exit");
      }
      respond(true, { ok: true, pid: process.pid, status: "scheduled" });
    } catch (error) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatErrorMessage(error)));
    }
  },
  "gateway.restart.request": async (options) => {
    const { respond, params } = options;
    if (!isRecord(params)) {
      rejectRestartRequest(respond, "invalid gateway.restart.request params");
      return;
    }
    const reason = normalizeReason(params.reason);
    const target = parseTargetedGatewayRestart(params.target);
    if (target === null) {
      rejectRestartRequest(respond, "invalid targeted gateway restart");
      return;
    }
    if (target && params.safe !== undefined && typeof params.safe !== "boolean") {
      rejectRestartRequest(respond, "invalid safe targeted restart mode");
      return;
    }
    if (target && params.safe === true && params.restartIntent !== undefined) {
      rejectRestartRequest(respond, "safe targeted restart does not accept intent");
      return;
    }
    if (target && params.safe !== true) {
      const intent = parseTargetedGatewayRestartIntent(params.restartIntent, reason);
      if (!intent) {
        rejectRestartRequest(respond, "invalid targeted gateway restart intent");
        return;
      }
      const activeLock = await readActiveGatewayLockIdentity().catch(() => undefined);
      if (
        activeLock?.pid !== process.pid ||
        activeLock.pid !== target.pid ||
        activeLock.ownerId !== target.ownerId ||
        activeLock.port !== target.port
      ) {
        rejectRestartRequest(respond, "target gateway no longer owns the active lock");
        return;
      }
      readGatewayRequestMutationAuthority(options).assertCurrent();
      const result = requestGatewayRestartWithSignalAdmission(reason, intent);
      if (result.status === "failed") {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.UNAVAILABLE, "target gateway restart delivery failed"),
        );
        return;
      }
      respond(true, {
        ok: true,
        status: result.status,
        pid: process.pid,
      });
      return;
    }
    // Retain chat ownership independently of the completed tool turn, like /restart.
    const restartParams = {
      requester: params.requester,
      sessionKey: params.sessionKey,
      deliveryContext: params.deliveryContext,
      note: params.note,
    };
    if (!validateUpdateRunParams(restartParams)) {
      rejectRestartRequest(respond, "invalid gateway restart requester or delivery");
      return;
    }
    const requester = restartParams.requester;
    const chat = requester?.channel && !isInternalMessageChannel(requester.channel);
    const owner = chat
      ? await prepareCommandOwnerAuthority(options.context.getRuntimeConfig(), requester)
      : undefined;
    const assertOwnerCurrent = () => {
      if (!chat) {
        return;
      }
      const config = options.context.getRuntimeConfig();
      if (!owner?.isCurrent(config)) {
        throw new Error("Gateway maintenance requires a current owner principal.");
      }
      if (!isRestartEnabled(config)) {
        throw new Error("Restarts from chat are disabled (commands.restart=false).");
      }
    };
    const { sessionKey, deliveryContext, threadId, note } =
      parseRestartRequestParams(restartParams);
    let revision: number | undefined;
    const clearNotice = async () => {
      if (revision !== undefined) {
        await clearRestartSentinelIfRevision(revision);
      }
    };
    assertOwnerCurrent();
    readGatewayRequestMutationAuthority(options).assertCurrent();
    const result = scheduleSafeGatewayRestart({
      reason,
      skipDeferral: params.skipDeferral === true,
      sessionKey,
      ...(chat || sessionKey
        ? {
            emitHooks: {
              assertCurrent: assertOwnerCurrent,
              beforeEmit: async () => {
                if (!sessionKey) {
                  return;
                }
                revision = (
                  await writeRestartSentinel({
                    kind: "restart",
                    status: "ok",
                    ts: Date.now(),
                    sessionKey,
                    deliveryContext,
                    threadId,
                    message: note ?? "Gateway restarted.",
                    continuation: null,
                    stats: { mode: "gateway.restart", reason },
                  })
                ).revision;
              },
              afterEmitRejected: clearNotice,
              afterEmitFailed: clearNotice,
            },
          }
        : {}),
    });
    respond(true, result);
  },
  // Deprecated compatibility preview for shipped read-only clients. This is
  // restart-specific information, not the atomic fence owned by suspend.prepare.
  "gateway.restart.preflight": async ({ respond }) => {
    respond(true, createSafeGatewayRestartPreflight());
  },
};
