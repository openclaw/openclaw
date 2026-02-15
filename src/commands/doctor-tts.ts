import type { OpenClawConfig } from "../config/config.js";
import { runExec } from "../process/exec.js";
import { note } from "../terminal/note.js";

/**
 * Check if pocket-tts CLI is installed and accessible.
 */
async function isPocketTtsInstalled(): Promise<boolean> {
  try {
    await runExec("pocket-tts", ["--version"], { timeoutMs: 5_000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if pocket-tts server is running at the given URL.
 */
async function isPocketServerHealthy(baseUrl: string): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    try {
      const url = baseUrl.replace(/\/+$/, "") + "/health";
      const response = await fetch(url, {
        method: "GET",
        signal: controller.signal,
      });
      return response.ok;
    } finally {
      clearTimeout(timeout);
    }
  } catch {
    return false;
  }
}

/**
 * Note TTS configuration warnings.
 * Called from doctor.ts.
 */
export async function noteTtsConfigWarnings(cfg: OpenClawConfig): Promise<void> {
  const ttsConfig = cfg.messages?.tts;
  if (!ttsConfig) {
    return;
  }

  const pocket = ttsConfig.pocket;
  const isPocketProvider = ttsConfig.provider === "pocket";
  const isPocketEnabled = pocket?.enabled !== false; // defaults to true

  // Only check pocket if it's relevant
  if (!isPocketProvider && !isPocketEnabled) {
    return;
  }

  const warnings: string[] = [];

  // Check if pocket-tts CLI is installed
  const installed = await isPocketTtsInstalled();
  if (!installed) {
    if (isPocketProvider) {
      warnings.push(
        "pocket-tts is not installed but configured as the TTS provider.",
        "  Install: pip install pocket-tts",
        "  Or change provider: clawdbot config set messages.tts.provider openai",
      );
    } else if (pocket?.autoStart) {
      warnings.push(
        "pocket.autoStart is enabled but pocket-tts is not installed.",
        "  Install: pip install pocket-tts",
        "  Or disable: clawdbot config set messages.tts.pocket.autoStart false",
      );
    }
  }

  // Check if server is running (only if autoStart is off)
  if (installed && isPocketProvider && !pocket?.autoStart) {
    const baseUrl = pocket?.baseUrl || "http://localhost:8000";
    const healthy = await isPocketServerHealthy(baseUrl);
    if (!healthy) {
      warnings.push(
        `pocket-tts server is not running at ${baseUrl}.`,
        "  Start manually: pocket-tts serve --voice alba",
        "  Or enable auto-start: clawdbot config set messages.tts.pocket.autoStart true",
      );
    }
  }

  if (warnings.length > 0) {
    note(warnings.join("\n"), "TTS");
  }
}
