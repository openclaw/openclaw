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

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 60_000);

  try {
    const response = await fetch("https://app.resemble.ai/api/v2/detect", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        Prefer: "wait",
      },
      body: JSON.stringify({ url: mediaUrl, visualize: true }),
      signal: controller.signal,
    });

    if (!response.ok) {
      return {
        success: false,
        error: `Resemble Detect API error: ${response.status} ${response.statusText}`,
      };
    }

    const data = await response.json();
    return { success: true, item: data.item ?? data };
  } catch (err: unknown) {
    const error = err as Error;
    if (error.name === "AbortError") {
      return { success: false, error: "Resemble Detect API request timed out." };
    }
    const message = error.message ? error.message : String(err);
    return { success: false, error: message };
  } finally {
    clearTimeout(timeoutId);
  }
}
