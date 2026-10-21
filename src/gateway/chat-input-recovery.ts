import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { GatewayClientInfo } from "../../packages/gateway-protocol/src/client-info.js";
import { readSessionEntryReadOnlyInWorker } from "../config/sessions/session-entry-read-runtime.js";
import { MEDIA_ONLY_USER_TEXT } from "../sessions/user-turn-media.js";
import { extractTextFromChatContent } from "../shared/chat-content.js";
import {
  chatInputRecoveryAdmission,
  type ChatInputRecoveryTarget,
} from "./chat-input-recovery-source.js";
import type { GatewayMethodRegistry } from "./methods/registry.js";
import { decodeGatewayOperatorRecoverySource } from "./operator-run-recovery-source.codec.js";
import { restoreGatewayOperatorSource } from "./operator-run-recovery.js";
import type { PendingInputRecoveryTrace } from "./pending-input-recovery-trace.js";
import { dispatchGatewayRequestInProcess } from "./server-in-process-dispatch.js";
import type { GatewayRequestContext } from "./server-methods/types.js";
import { createSyntheticPluginRuntimeClient } from "./server-plugin-runtime-client.js";

/** Re-enter chat admission with exact durable custody and current operator authority. */
export async function resumeChatInput(
  context: GatewayRequestContext,
  target: ChatInputRecoveryTarget,
  options: {
    signal: AbortSignal;
    assertCurrent: () => void;
    trace?: PendingInputRecoveryTrace;
  },
  methodRegistry?: GatewayMethodRegistry,
): Promise<void> {
  const assertCurrent = () => {
    options.signal.throwIfAborted();
    options.assertCurrent();
  };
  assertCurrent();
  const { message, requestHash } = target;
  const metadata = message["__openclaw"]?.chatInputRecovery;
  if (!isRecord(metadata) || metadata.version !== 1 || !isRecord(metadata.request)) {
    throw new Error("Interrupted chat input has no resumable operator source.");
  }
  const request = metadata.request;
  const source = decodeGatewayOperatorRecoverySource(metadata.source);
  if (
    source.agentId !== target.agentId ||
    source.sessionKey !== target.sessionKey ||
    source.sessionId !== target.sessionId ||
    source.sourceRunId !== target.runId ||
    !requestHash.startsWith("request:")
  ) {
    throw new Error("Interrupted chat input does not match its original admission.");
  }
  const checkSource = async () => {
    const entry = await readSessionEntryReadOnlyInWorker(target, assertCurrent);
    if (
      !entry ||
      entry.archivedAt ||
      entry.sessionId !== source.sessionId ||
      entry.lifecycleRevision !== source.lifecycleRevision
    ) {
      throw new Error("Interrupted chat input session was archived, reset, or replaced.");
    }
  };
  const restoreAuthority = () =>
    restoreGatewayOperatorSource({
      target,
      snapshot: source.snapshot,
      context,
      assertCurrent,
      prepareCurrent: () => options.trace?.measure("sessionLoadMs", checkSource) ?? checkSource(),
    });
  const restored = await (options.trace?.measure("authorityRestoreMs", restoreAuthority) ??
    restoreAuthority());
  try {
    const guard = restored.authority.assertCurrent;
    const client = createSyntheticPluginRuntimeClient({
      authenticatedUserProfile: restored.authenticatedUserProfile,
      operatorRoleActor: { kind: "operator", profileId: restored.authority.profileId },
      operatorRunAuthority: restored.authority,
      scopes: [...restored.authority.scopes],
    });
    if (isRecord(metadata.clientInfo)) {
      client.connect.client = metadata.clientInfo as GatewayClientInfo; // SAFETY: Stored by chat admission.
    }
    const text = extractTextFromChatContent(message.content, { joinWith: "\n" }) ?? "";
    guard();
    const dispatch = () =>
      chatInputRecoveryAdmission.run(
        {
          target,
          requestFingerprint: requestHash.slice("request:".length),
          suppressCommandInterpretation: metadata.suppressCommandInterpretation === true,
          requesterProfile: {
            id: restored.authenticatedUserProfile.profileId,
            displayName: restored.authenticatedUserProfile.displayName,
            isCurrent: () => !restored.authority.signal?.aborted,
          },
        },
        () =>
          dispatchGatewayRequestInProcess(
            "chat.send",
            {
              ...request,
              agentId: target.agentId,
              sessionKey: target.sessionKey,
              sessionId: target.sessionId,
              idempotencyKey: target.runId,
              message: text || MEDIA_ONLY_USER_TEXT,
            },
            {
              client,
              context,
              methodRegistry,
              signal: options.signal,
              assertPreparationCurrent: guard,
              sessionMutationCommitGuard: guard,
              hasCurrentClientAuthority: () => {
                guard();
                return true;
              },
            },
          ),
      );
    await (options.trace?.measure("dispatchAckMs", dispatch) ?? dispatch());
  } finally {
    restored.release();
  }
}
