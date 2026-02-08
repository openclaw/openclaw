import { spinner } from "@clack/prompts";
import chalk from "chalk";
import type { OpenClawConfig } from "../config/config.js";
import { note } from "../terminal/note.js";

const PROVIDER_URLS: Record<string, string> = {
  openai: "https://api.openai.com/v1",
  anthropic: "https://api.anthropic.com",
  deepseek: "https://api.deepseek.com",
  moonshot: "https://api.moonshot.ai/v1",
  minimax: "https://api.minimax.io/v1",
  xai: "https://api.x.ai/v1",
  google: "https://generativelanguage.googleapis.com",
  qianfan: "https://qianfan.baidubce.com/v2",
  mistral: "https://api.mistral.ai/v1",
  groq: "https://api.groq.com/openai/v1",
  together: "https://api.together.xyz/v1",
  fireworks: "https://api.fireworks.ai/inference/v1",
  openrouter: "https://openrouter.ai/api/v1",
};

export async function noteNetworkConnectivity(cfg: OpenClawConfig) {
  const s = spinner();

  s.start("Checking network connectivity");

  // Determine which providers to check
  // Always check OpenAI and Anthropic as they are the most common defaults
  const providersToCheck = new Set<string>(["openai", "anthropic"]);

  // Add providers from config
  if (cfg.models?.providers) {
    for (const p of Object.keys(cfg.models.providers)) {
      if (p in PROVIDER_URLS) {
        providersToCheck.add(p);
      }
    }
  }

  // Also check based on current active model if possible, but the config providers list should cover it.

  const results: { provider: string; status: "OK" | "Failed"; error?: string; time?: number }[] =
    [];

  const checks = Array.from(providersToCheck).map(async (provider) => {
    const url = PROVIDER_URLS[provider];
    if (!url) {
      return;
    }

    const start = Date.now();
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000); // 5s timeout

      // We use a simple fetch to the base URL.
      // 404/401/403 are considered "Connected" because we reached the server.
      // Only network errors (timeout, ECONNREFUSED) are "Failed".
      await fetch(url, {
        method: "HEAD",
        signal: controller.signal,
      }).catch(async (err) => {
        // If HEAD fails (e.g. 405 Method Not Allowed), try GET
        // If it was a network error, GET will likely fail too, but worth a shot if HEAD is blocked
        if (err.name === "AbortError") {
          throw err;
        }
        return fetch(url, {
          method: "GET",
          signal: controller.signal,
        });
      });

      clearTimeout(timeoutId);
      const time = Date.now() - start;
      results.push({ provider, status: "OK", time });
    } catch (err: unknown) {
      const time = Date.now() - start;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const error = err as any;
      let errorMsg = error.message;
      if (error.name === "AbortError" || error.code === "ETIMEDOUT") {
        errorMsg = "Timeout";
      } else if (error.code === "ECONNREFUSED") {
        errorMsg = "Connection Refused";
      } else if (error.cause) {
        errorMsg = error.cause.message || errorMsg;
      }
      results.push({ provider, status: "Failed", error: errorMsg, time });
    }
  });

  await Promise.all(checks);

  s.stop("Network connectivity");

  // Sort results: Failed first, then by provider name
  results.sort((a, b) => {
    if (a.status !== b.status) {
      return a.status === "Failed" ? -1 : 1;
    }
    return a.provider.localeCompare(b.provider);
  });

  if (results.length === 0) {
    return;
  }

  const lines: string[] = [];
  for (const res of results) {
    const name = res.provider.charAt(0).toUpperCase() + res.provider.slice(1);
    if (res.status === "OK") {
      lines.push(`${chalk.green("●")} ${name} ${chalk.dim(`(${res.time}ms)`)}`);
    } else {
      lines.push(`${chalk.red("✖")} ${name}: ${chalk.red(res.error || "Unknown Error")}`);
    }
  }

  note(lines.join("\n"), "Network connectivity");
}
