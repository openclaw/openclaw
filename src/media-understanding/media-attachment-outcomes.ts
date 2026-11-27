import { readTransportDiagnosticLabel } from "../../packages/ai/src/utils/provider-error.js";
import type { MediaAttachmentDisposition } from "../../packages/media-understanding-common/src/types.js";
import { loadAuthProfileStoreForRuntimeAsync } from "../agents/auth-profiles/store-runtime.js";
import { isProviderAuthError } from "../agents/model-auth-runtime-shared.js";
import { ProviderHttpError } from "../agents/provider-http-errors.js";
import { signInNeedsApiKeyForVoice } from "../agents/voice-sign-in-policy.js";

/** Only an actual audio attempt rejected during credential selection can report this cause. */
export async function readAudioApiKeyFailure(error: unknown, agentDir: string | undefined) {
  if (!agentDir || !isProviderAuthError(error)) {
    return undefined;
  }
  const store = await loadAuthProfileStoreForRuntimeAsync(agentDir, {
    readOnly: true,
    allowKeychainPrompt: false,
  }).catch(() => undefined);
  return store && signInNeedsApiKeyForVoice(store, error.provider) ? error.provider : undefined;
}

/** Keeps a provider HTTP failure's own status and code; other errors stay unannotated. */
export function failedAttachmentDisposition(error: unknown): MediaAttachmentDisposition {
  if (!(error instanceof ProviderHttpError)) {
    return { kind: "failed" };
  }
  const code = readTransportDiagnosticLabel(error.code);
  return { kind: "failed", status: error.status, ...(typeof code === "string" ? { code } : {}) };
}
