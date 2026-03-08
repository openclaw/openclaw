import { deriveOpenAICodexCanonicalProfileId } from "../agents/auth-profiles/openai-codex-profile-id.js";

export function makeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" }), "utf8").toString(
    "base64url",
  );
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${header}.${body}.sig`;
}

export function expectedOpenAICodexProfileId(params: {
  accountId: string;
  iss: string;
  sub: string;
}): string {
  const access = makeJwt({
    iss: params.iss,
    sub: params.sub,
    "https://api.openai.com/auth": { chatgpt_account_id: params.accountId },
  });
  const profileId = deriveOpenAICodexCanonicalProfileId({
    provider: "openai-codex",
    access,
    accountId: params.accountId,
  });
  if (!profileId) {
    throw new Error("failed to derive expected OpenAI Codex profile id");
  }
  return profileId;
}
