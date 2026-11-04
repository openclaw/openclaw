import { createDeferredCore } from "../../../../src/shared/deferred.js";
import type { ApplicationContext } from "../../app/context.ts";
import { t } from "../../i18n/index.ts";
import { registerModelControlsEnglish } from "../../i18n/locales/en-model-controls.ts";
import type { ChatAttachment } from "../../lib/chat/chat-types.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { isAgentRuntimeRestrictionErrorDetails } from "../../lib/protocol-validators.generated/session-input.js";
import type { SessionCreateOutcome } from "../../lib/sessions/create.ts";
import { areUiSessionKeysEquivalent } from "../../lib/sessions/session-key.ts";
import { showToast } from "../../lib/toast.ts";
import {
  cloneChatAttachmentsForIndependentOwner,
  releaseChatAttachmentPayloads,
} from "../chat/attachment-payload-store.ts";
import { buildInitialChatSubmission } from "../chat/user-message-content.ts";
import { retainCreatedComposer } from "./creation-composer-registry.ts";
import type { CreationComposer } from "./creation-composer.ts";
import type { InstantThreadHandoff } from "./instant-thread-handoff.ts";
import { retainRejectedInitialTurn } from "./rejected-initial-turn.ts";
import type { StartedSessionNavigation } from "./started-session-navigation.ts";

registerModelControlsEnglish();

/** Transfer accepted or rejected first-turn display through the existing owners. */
type InitialTurn = {
  context: ApplicationContext;
  client: NonNullable<ApplicationContext["gateway"]["snapshot"]["client"]>;
  agentId: string;
  result: SessionCreateOutcome;
  turn: Parameters<typeof buildInitialChatSubmission>[1] & { attachments: ChatAttachment[] };
};

function retainInitialSessionTurn(options: InitialTurn, retryAfter?: Promise<boolean>): boolean {
  const { context, result, turn } = options;
  const { text: message, attachments } = turn;
  const handedOffAttachments =
    result.initialRun.status === "rejected" &&
    retainRejectedInitialTurn({
      agentId: options.agentId,
      attachments,
      context,
      error: result.initialRun.error,
      message,
      mentions: turn.mentions,
      sessionKey: result.key,
      sessionId: typeof result.entry?.sessionId === "string" ? result.entry.sessionId : undefined,
      retryAfter,
    });
  return handedOffAttachments;
}

/** Settle only the captured draft and publish under the still-current route owner. */
export async function completeInitialSessionTurn(
  options: InitialTurn & {
    instant: InstantThreadHandoff | undefined;
    composer?: CreationComposer;
    navigation: StartedSessionNavigation;
    isCurrent: () => boolean;
    clearDraft: (releasePayloads: boolean, keepPending?: boolean) => Promise<void>;
    completeInBackground: (key: string, runId?: string) => boolean;
    finishNavigation: () => void;
    onAccepted?: () => void;
    onRejectedPrompt?: (error: string) => void;
  },
) {
  const { context, client, agentId, result, instant } = options;
  const { key, initialRun } = result;
  // Capture attachment display bytes before consuming the accepted draft. Lazy
  // preview navigation must not keep sent input in the new-session cache.
  const acceptedSubmission =
    initialRun.status === "started"
      ? buildInitialChatSubmission(key, options.turn, client, initialRun.runId)
      : null;
  if (!instant && options.isCurrent()) {
    context.chatSubmissions.retain(acceptedSubmission);
  }
  const clearing =
    initialRun.status !== "rejected"
      ? options.clearDraft(
          true,
          options.isCurrent() && (!instant || instant.isCurrent()) ? undefined : false,
        )
      : undefined;
  if (instant || clearing) {
    await Promise.all([instant?.waitForReady(), clearing]);
  }
  if (!options.isCurrent() || (instant && !instant.isCurrent())) {
    // A confirmed send retires its captured draft, but never publishes a first
    // turn into a different authenticated or navigation owner.
    return;
  }
  const restriction =
    initialRun.status === "rejected" &&
    isAgentRuntimeRestrictionErrorDetails(initialRun.errorDetails)
      ? initialRun.errorDetails
      : undefined;
  const retry = restriction ? createDeferredCore<boolean>() : undefined;
  try {
    if (initialRun.status === "rejected" && options.onRejectedPrompt) {
      // The launcher and destination retain separate owners of a rejected prompt.
      const attachments = cloneChatAttachmentsForIndependentOwner(options.turn.attachments);
      const handedOff = retainInitialSessionTurn(
        { ...options, turn: { ...options.turn, attachments } },
        retry?.promise,
      );
      if (!handedOff) {
        releaseChatAttachmentPayloads(attachments);
      }
      options.onRejectedPrompt(initialRun.error);
    } else if (clearing) {
      if (instant) {
        context.chatSubmissions.retain(acceptedSubmission);
      }
    } else {
      const handedOffAttachments = retainInitialSessionTurn(options, retry?.promise);
      await options.clearDraft(!handedOffAttachments);
    }
    if (!options.isCurrent() || (instant && !instant.isCurrent())) {
      return;
    }
    if (
      options.completeInBackground(
        key,
        initialRun.status === "started" ? initialRun.runId : undefined,
      )
    ) {
      options.onAccepted?.();
      return;
    }
    if (options.composer) {
      options.composer.accept(result);
      retainCreatedComposer(context, key, options.composer);
    }
    instant?.admitted(key, agentId);
    await options.navigation.navigate(
      context,
      { client, key, agentId, entry: result.entry },
      instant?.commit.bind(instant),
    );
    options.finishNavigation();
    if (restriction) {
      const snapshot = context.gateway.snapshot;
      const canDispatch = () =>
        context.gateway.snapshot.phase === "connected" &&
        context.gateway.snapshot.client === client &&
        context.gateway.snapshot.hello === snapshot.hello &&
        areUiSessionKeysEquivalent(context.gateway.snapshot.sessionKey, key);
      try {
        // Load consent only for refused first turns, after capturing the navigation owner.
        const { confirmNativeRuntimePermissionRecovery } =
          await import("../chat/chat-native-runtime-recovery.ts");
        const recovered = await confirmNativeRuntimePermissionRecovery(
          { sessions: context.sessions, hello: snapshot.hello },
          key,
          restriction,
          {
            agentId,
            expectedSessionId:
              typeof result.entry?.sessionId === "string" ? result.entry.sessionId : undefined,
            signal: context.lifecycleAbortSignal,
            retriesMessage: true,
            canDispatch,
          },
        );
        retry?.resolve(Boolean(recovered && canDispatch()));
      } catch (error) {
        if (canDispatch()) {
          showToast({
            message: t("chat.nativeRuntimeRecovery.failed", { error: formatUiError(error) }),
          });
        }
      }
    }
  } finally {
    retry?.resolve(false);
  }
}
