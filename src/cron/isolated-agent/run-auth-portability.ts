import type { AuthProfileCredential } from "../../agents/auth-profiles/types.js";
import { isOpenAIProvider } from "../../agents/openai-routing.js";
import { decodeOpenAICodexJwtPayload } from "../../plugin-sdk/provider-openai-chatgpt-auth.js";

/** Returns an actionable error only for credentials known to be Codex-native-only. */
export function resolveScheduledOpenClawAuthPortabilityError(params: {
  provider: string;
  profileId: string;
  credential: AuthProfileCredential | undefined;
}): string | undefined {
  if (!isOpenAIProvider(params.provider)) {
    return undefined;
  }
  const credential = params.credential;
  if (!credential) {
    return `Scheduled execution cannot use auth profile "${params.profileId}" through the OpenClaw runtime. Run \`openclaw models auth login --provider openai\`, then retry.`;
  }
  if (credential.type === "api_key") {
    return undefined;
  }
  const token = credential.type === "oauth" ? credential.access : credential.token;
  if (!token || decodeOpenAICodexJwtPayload(token)) {
    // Secret-ref credentials are materialized later by the ordinary auth owner.
    return undefined;
  }
  return `Scheduled execution cannot translate auth profile "${params.profileId}" from an opaque Codex token into OpenClaw provider auth. Run \`openclaw models auth login --provider openai\`, then retry.`;
}
