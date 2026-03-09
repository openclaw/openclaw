import type { OpenClawConfig } from "../config/types.js";
import { normalizeResolvedSecretInputString } from "../config/types.secrets.js";

export async function detectDeepfake(mediaUrl: string, cfg: OpenClawConfig) {
  const apiKey =
    normalizeResolvedSecretInputString({
      value: cfg.resemble?.apiKey,
      path: "resemble.apiKey",
    }) || process.env.RESEMBLE_API_KEY;

  if (!apiKey) {
    return {
      success: false,
      error: "Resemble API key is not configured. Please add it to your configuration.",
    };
  }

  try {
    const response = await fetch("https://app.resemble.ai/api/v2/detect", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        Prefer: "wait",
      },
      body: JSON.stringify({ url: mediaUrl, visualize: true }),
    });

    if (!response.ok) {
      return {
        success: false,
        error: `Resemble Detect API error: ${response.status} ${response.statusText}`,
      };
    }

    const data = await response.json();
    return { success: true, item: data.item || data };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, error: message };
  }
}
