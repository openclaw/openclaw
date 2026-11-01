import {
  CHAT_FOLLOW_UP_PREFERENCE_KEY,
  normalizeChatFollowUpModePreference,
} from "../../../packages/gateway-protocol/src/schema/chat-follow-up-preferences.js";
import { readChannelContextGatewayContextResolver } from "../../channels/message-access/admission-evidence.js";
import { resolveSessionStorePathCore } from "../../config/sessions.js";
import { getPluginRuntimeGatewayRequestScope } from "../../plugins/runtime/gateway-request-scope.js";
import { getSessionControllerSourceIdentity } from "../../sessions/session-controller.identity.js";
import {
  interruptForSessionControllerInput,
  isSessionControllerInputInterruptible,
} from "../../sessions/session-controller.interrupt-input.js";
import { captureSessionControllerStop } from "../../sessions/session-controller.stop.js";
import { captureSessionTarget } from "../../sessions/session-controller.target.js";
import {
  getCanonicalUserPreferences,
  setCanonicalUserPreferences,
} from "../../state/user-preferences.js";
import { getCommandOwnerAuthority } from "../command-owner-authority.js";
import { commandReply, defineAuthorizedTextCommand, matchCommandPrefix } from "./command-gates.js";
import { resolveCommandSourceSessionKey } from "./command-source-session-key.js";
import { resolveCommandSessionEntryForKey } from "./commands-session-store.js";
import type { CommandHandler, HandleCommandsParams } from "./commands-types.js";
import { readReplySourceInput } from "./reply-source-binding.js";

function assertControlCurrent(params: HandleCommandsParams) {
  params.opts?.abortSignal?.throwIfAborted();
  params.commandInvocationSignal?.throwIfAborted();
  params.opts?.operatorAuthority?.assertCurrent();
  params.opts?.assertChannelAuthority?.();
  const owner = getCommandOwnerAuthority(params.rootCtx ?? params.ctx);
  if (owner && !owner.isCurrent()) {
    throw new Error("Your command authority changed; send a new request.");
  }
  if (params.opts?.isCommandTargetCurrent?.sessionSource) {
    params.opts.isCommandTargetCurrent.sessionSource();
  } else if (params.opts?.isCommandTargetCurrent?.() === false) {
    throw new Error("The selected session changed; send a new request.");
  }
}

export const handleFollowupModeCommand: CommandHandler = defineAuthorizedTextCommand(
  { label: "/followupmode", match: (body) => matchCommandPrefix(body, "/followupmode") },
  async (params, raw) => {
    const authority =
      params.opts?.operatorAuthority ?? getCommandOwnerAuthority(params.ctx)?.operatorAuthority;
    if (!authority?.profileId) {
      return commandReply(
        "A linked personal profile is required. Use /queue followup|steer|interrupt for this session instead.",
      );
    }
    assertControlCurrent(params);
    authority.assertCurrent();
    if (!raw) {
      const preferences = await getCanonicalUserPreferences(authority.profileId, [
        CHAT_FOLLOW_UP_PREFERENCE_KEY,
      ]);
      assertControlCurrent(params);
      authority.assertCurrent();
      return commandReply(
        "Personal follow-up mode: " +
          (normalizeChatFollowUpModePreference(
            preferences?.entries[CHAT_FOLLOW_UP_PREFERENCE_KEY],
          ) ?? "server default") +
          ". Usage: /followupmode queue|steer|interrupt|default. Session /queue and per-message choices take precedence. Queue waits; steer joins at the next model/tool boundary; interrupt requests cancellation immediately, then waits for the previous writer to settle.",
      );
    }
    const mode = normalizeChatFollowUpModePreference(raw);
    if (!mode && raw !== "default") {
      return commandReply("Usage: /followupmode queue|steer|interrupt|default");
    }
    await params.opts?.turnAdoptionLifecycle?.onAdopted();
    const result = await setCanonicalUserPreferences(
      authority.profileId,
      {
        [CHAT_FOLLOW_UP_PREFERENCE_KEY]: mode ?? null,
      },
      {
        assertCurrent: () => {
          assertControlCurrent(params);
          authority.assertCurrent();
        },
      },
    );
    assertControlCurrent(params);
    authority.assertCurrent();
    return commandReply(
      result?.ok
        ? "Personal follow-up mode: " +
            (mode ?? "server default") +
            ". Session /queue and per-message choices still take precedence."
        : "The personal preference was not saved. Reconnect and try again.",
    );
  },
);

export const handleInterruptCommand: CommandHandler = defineAuthorizedTextCommand(
  { label: "/interrupt", match: (body) => matchCommandPrefix(body, "/interrupt") },
  async (params, id) => {
    const current = await params.opts?.isCommandTargetCurrent?.();
    if (current === false) {
      return commandReply("The selected session changed; send a new request.");
    }
    assertControlCurrent(params);
    const key = resolveCommandSourceSessionKey(params, { preferCommandTarget: true });
    const selected = resolveCommandSessionEntryForKey(params.sessionStore, key);
    const entry = selected.entry ?? (key === params.sessionKey ? params.sessionEntry : undefined);
    if (!key || !entry?.sessionId) {
      return commandReply("No current conversation is selected.");
    }
    const captured = captureSessionControllerStop({
      includeActive: false,
      targets: [
        captureSessionTarget({
          storeScope:
            params.storePath ??
            resolveSessionStorePathCore(params.cfg.session?.store, { agentId: params.agentId }),
          sessionKey: selected.key ?? key,
          agentId: params.agentId,
          incarnation: entry.sessionId,
        }),
      ],
      resolveGatewayContext:
        readChannelContextGatewayContextResolver(params.rootCtx ?? params.ctx) ??
        getPluginRuntimeGatewayRequestScope()?.resolveGatewayContext,
    });
    const queued = captured.inputs.filter((input) => {
      const identity = getSessionControllerSourceIdentity(input);
      return (
        input !== readReplySourceInput(params.opts) &&
        identity.sessionId === entry.sessionId &&
        input.sourceAdapter?.controlUiVisible !== false &&
        isSessionControllerInputInterruptible(input)
      );
    });
    if (!id || id === "list") {
      return commandReply(
        queued.length
          ? "Queued input IDs (use /interrupt <id> to interrupt and send that original input):\n" +
              queued.map((input) => input.protocolRunId ?? input.instance.id).join("\n")
          : "No safely interruptible queued input remains in this conversation.",
      );
    }
    const input = queued.find(
      (candidate) => (candidate.protocolRunId ?? candidate.instance.id) === id,
    );
    if (!input) {
      return commandReply(
        "That input is no longer safely queued here. Nothing was resent or interrupted. Use /interrupt list to refresh.",
      );
    }
    await params.opts?.turnAdoptionLifecycle?.onAdopted();
    assertControlCurrent(params);
    const result = interruptForSessionControllerInput(input, () => assertControlCurrent(params));
    return commandReply(
      result.status === "queued"
        ? "Interrupt & send requested for the original queued input. The previous writer may need to settle before it runs. Other queued inputs are unchanged."
        : "That input is no longer safely queued. Nothing was resent.",
    );
  },
);
