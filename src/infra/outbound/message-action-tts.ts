// Message-action TTS helpers lazily apply session/config driven speech output
// to send payloads without loading TTS providers for ordinary sends.
import { getReplyPayloadMetadata, type ReplyPayload } from "../../auto-reply/reply-payload.js";
import { resolveSessionStorePathCore } from "../../config/sessions.js";
import { loadSessionEntryReadOnly } from "../../config/sessions/session-accessor.js";
import { captureIncognitoSessionSource } from "../../config/sessions/session-incognito-binding.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { TtsAutoMode } from "../../config/types.tts.js";
import { createLazyRuntimeModule } from "../../shared/lazy-runtime.js";
import { IncognitoSessionMissingError } from "../../state/incognito-session-error.js";
import { shouldAttemptTtsPayload } from "../../tts/tts-config.js";
import { prepareTtsPreferences } from "../../tts/tts-preferences.js";

// Keep the TTS runtime lazy so ordinary message sends do not pay the provider import cost.
const loadMessageActionTtsRuntime = createLazyRuntimeModule(
  () => import("../../tts/tts.runtime.js"),
);

export async function maybeApplyTtsToMessageActionSendPayload(params: {
  payload: ReplyPayload;
  cfg: OpenClawConfig;
  channel: string;
  accountId?: string | null;
  agentId?: string;
  sessionKey?: string;
  inboundAudio?: boolean;
  dryRun: boolean;
}): Promise<ReplyPayload> {
  if (params.dryRun) {
    return params.payload;
  }
  const sessionKey = params.sessionKey?.trim();
  const storePath = sessionKey
    ? resolveSessionStorePathCore(params.cfg.session?.store, { agentId: params.agentId })
    : undefined;
  const source = sessionKey
    ? captureIncognitoSessionSource({ agentId: params.agentId, sessionKey, storePath })
    : undefined;
  let ttsAuto: TtsAutoMode | undefined;
  let assertSourceCurrent = () => {};
  if (source && sessionKey) {
    source.admissionSignal?.throwIfAborted();
    if ("kind" in source) {
      throw new IncognitoSessionMissingError();
    } else {
      const claim = source.actor.sessions.captureCurrent(sessionKey);
      const policy = source.actor.sessions.readPolicy(sessionKey);
      if (!policy) {
        throw new IncognitoSessionMissingError();
      }
      ttsAuto = policy.ttsAuto;
      assertSourceCurrent = () => {
        source.admissionSignal?.throwIfAborted();
        source.actor.assertReadable();
        claim.assertCurrent();
        if (source.actor.sessions.readPolicy(sessionKey)?.ttsAuto !== ttsAuto) {
          throw new Error("Message TTS preference changed before delivery");
        }
      };
    }
  } else if (sessionKey) {
    try {
      ttsAuto = loadSessionEntryReadOnly({
        agentId: params.agentId,
        sessionKey,
        storePath,
      })?.ttsAuto;
    } catch {
      // Missing or unreadable session stores should not block message delivery.
    }
  }
  const apply = async () => {
    assertSourceCurrent();
    const explicitTts = getReplyPayloadMetadata(params.payload)?.ttsExplicit === true;
    const preparedTtsPreferences = await prepareTtsPreferences();
    assertSourceCurrent();
    if (
      !explicitTts &&
      !shouldAttemptTtsPayload({
        cfg: params.cfg,
        preparedTtsPreferences,
        ttsAuto,
        agentId: params.agentId,
        channelId: params.channel,
        accountId: params.accountId ?? undefined,
      })
    ) {
      return params.payload;
    }
    const { maybeApplyTtsToPayload } = await loadMessageActionTtsRuntime();
    assertSourceCurrent();
    const payload = await maybeApplyTtsToPayload({
      payload: params.payload,
      preparedTtsPreferences,
      cfg: params.cfg,
      channel: params.channel,
      kind: "final",
      inboundAudio: params.inboundAudio,
      ttsAuto,
      agentId: params.agentId,
      accountId: params.accountId ?? undefined,
    });
    assertSourceCurrent();
    return payload;
  };
  return source && !("kind" in source) ? source.actor.sessions.withSharedState(apply) : apply();
}
