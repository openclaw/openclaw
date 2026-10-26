import { vi } from "vitest";
import { withMessageInjectionAdmission } from "../auto-reply/reply/message-injection-authority.js";
import { prepareReplyToolAuthority } from "../auto-reply/reply/reply-tool-authority.js";
import type {
  ReplyBackendQueueMessageOptions,
  ReplyOperation,
  ReplyToolAuthorityPreparation,
} from "../sessions/session-controller.contracts.js";
import { INTERNAL_MESSAGE_CHANNEL } from "../utils/message-channel-constants.js";

export async function attachLocalSteeringBackend(
  operation: ReplyOperation,
  senderId: string,
  options: {
    sessionId: string;
    sessionFile: string;
    runId: string;
    beforeAdmission?: (preparation: ReplyToolAuthorityPreparation) => Promise<void>;
  },
) {
  const queue = vi.fn((_text: string, _options?: ReplyBackendQueueMessageOptions) => {});
  await operation.bindToolAuthoritySnapshotAsync(
    prepareReplyToolAuthority({
      originatingChannel: INTERNAL_MESSAGE_CHANNEL,
      disableTools: false,
      run: {
        sessionId: options.sessionId,
        sessionFile: options.sessionFile,
        workspaceDir: "/tmp",
        provider: "openai",
        model: "gpt-test",
        config: {},
        messageProvider: INTERNAL_MESSAGE_CHANNEL,
        senderId,
        permissionMode: "full",
        senderIsOwner: false,
        traceAuthorized: false,
      },
    }),
  );
  await operation.bindToolAuthorityRouteAsync({ provider: "openai", model: "gpt-test" });
  operation.attachBackend({
    kind: "embedded",
    runId: options.runId,
    cancel: () => {},
    supportsTranscriptCommitWait: true,
    messageInjectionV2: {
      version: 2,
      isAvailable: () => true,
      queueMessage: async () => {
        throw new Error("Prepared steering is required");
      },
      queueMessageAsync: async (text, queuedOptions, preparation) => {
        await options.beforeAdmission?.(preparation);
        await withMessageInjectionAdmission(preparation.prepareCurrent, () => {
          preparation.assertCurrent();
          queue(text, queuedOptions);
        });
      },
    },
  });
  operation.setPhase("running");
  return queue;
}
