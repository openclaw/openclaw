import { vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { steerActiveSessionWithOptionalDeliveryWait } from "../../agents/embedded-agent-runner/run/attempt-queue-message.js";
import type {
  ReplyBackendHandle,
  ReplyBackendMessageInjectionV2,
} from "../../auto-reply/reply/reply-run-registry.contracts.js";

/** Wire the real AgentSession queue to its registered backend's guarded input boundary. */
export function createSteeringCustodyBackend(params: {
  session: Parameters<typeof steerActiveSessionWithOptionalDeliveryWait>[0];
  sessionKey: string;
  toolAuthorityFingerprint: string;
  supportsCrossProfileSteering: boolean;
}) {
  const accepted = createDeferred();
  const queueMessage = vi.fn<ReplyBackendMessageInjectionV2["queueMessage"]>(
    async (text, options, assertCurrent) =>
      steerActiveSessionWithOptionalDeliveryWait(
        params.session,
        text,
        {
          ...options,
          onQueueAccepted: (queued) => {
            options?.onQueueAccepted?.(queued);
            if (queued) {
              accepted.resolve();
            }
          },
        },
        params.sessionKey,
        () => {
          assertCurrent();
          return true;
        },
      ),
  );
  const handle: ReplyBackendHandle = {
    kind: "embedded",
    runId: "original-backing-run",
    toolAuthorityFingerprint: params.toolAuthorityFingerprint,
    supportsCrossProfileSteering: params.supportsCrossProfileSteering,
    cancel: vi.fn(),
    messageInjectionV2: { version: 2, isAvailable: () => true, queueMessage },
  };
  return { handle, queueMessage, accepted: accepted.promise };
}
