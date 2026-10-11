import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import {
  acquireSessionActorStorage,
  runWithSessionActorStorage,
} from "../../config/sessions/session-actor-storage-binding.js";
import { isIncognitoSessionKey } from "../../routing/session-key.js";
import {
  resolveChatSendSessionKey,
  resolveRequestedSessionAgentId,
} from "../session-request-agent.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

export async function runChatSendWithStorage(
  handlerOptions: GatewayRequestHandlerOptions,
  run: (storage?: { release(): void; retain(): void }) => Promise<void>,
): Promise<void> {
  const rawKey = handlerOptions.params.sessionKey;
  if (typeof rawKey !== "string" || !isIncognitoSessionKey(rawKey)) {
    return run();
  }
  const cfg = handlerOptions.context.getRuntimeConfig();
  const requested = resolveRequestedSessionAgentId(
    cfg,
    rawKey,
    typeof handlerOptions.params.agentId === "string" ? handlerOptions.params.agentId : undefined,
  );
  if (!requested.ok) {
    handlerOptions.respond(false, undefined, requested.error);
    return;
  }
  let active = true;
  let retained = false;
  const assertCurrent = () => {
    if (!active) {
      throw new Error("Chat session storage admission ended");
    }
  };
  const binding = await acquireSessionActorStorage(
    {
      sessionKey: resolveChatSendSessionKey(cfg, rawKey, requested.agentId),
      agentId: requested.agentId,
    },
    {
      lifetime: { assertCurrent, assertReadable: assertCurrent },
      authority: { assertCurrent, authorize: assertCurrent },
    },
  );
  if (!binding) {
    handlerOptions.respond(
      false,
      undefined,
      errorShape(
        ErrorCodes.INVALID_REQUEST,
        `Incognito session "${resolveChatSendSessionKey(cfg, rawKey, requested.agentId)}" was not found.`,
      ),
    );
    return;
  }
  const release = () => {
    if (!active) {
      return;
    }
    active = false;
    void binding.actor.release().catch((error: unknown) => {
      handlerOptions.context.logGateway.warn(
        `Chat session storage cleanup failed: ${String(error)}`,
      );
    });
  };
  try {
    await runWithSessionActorStorage(binding, () =>
      run({
        release,
        retain() {
          retained = true;
        },
      }),
    );
  } finally {
    // The existing chat admission retains the binding across ACK and collected work.
    if (!retained) {
      release();
    }
  }
}
