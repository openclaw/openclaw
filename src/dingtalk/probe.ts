import { getDingTalkAccessToken } from "./auth.js";

export async function probeDingTalk(
  clientId: string,
  clientSecret: string,
  timeoutMs = 5000,
): Promise<{ ok: boolean; tokenPresent: boolean; error?: string }> {
  try {
    const token = await Promise.race([
      getDingTalkAccessToken({ clientId, clientSecret }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("DingTalk probe timeout")), timeoutMs),
      ),
    ]);
    return { ok: Boolean(token), tokenPresent: Boolean(token) };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      tokenPresent: false,
      error: message,
    };
  }
}
