import type { MsgContext } from "../auto-reply/templating.js";
import { applyTemplate } from "../auto-reply/templating.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { logVerbose, shouldLogVerbose } from "../globals.js";
import { createAbortError, isAbortError } from "../infra/abort-signal.js";
import { cancelUnreadResponseBody, readResponseWithLimit } from "../infra/http-body.js";
import { fetchWithSsrFGuard, GUARDED_FETCH_MODE } from "../infra/net/fetch-guard.js";
import { CLI_OUTPUT_MAX_BUFFER } from "../media-understanding/defaults.js";
import { resolveScopeDecision, resolveTimeoutMs } from "../media-understanding/resolve.js";
import { runCommandWithTimeout } from "../process/exec.js";
import { DEFAULT_LINK_TIMEOUT_SECONDS } from "./defaults.js";
import { extractLinksFromMessage } from "./detect.js";

function isLinkUrlTemplate(value: string): boolean {
  return value.includes("LinkUrl") || value.includes("LinkFinalUrl");
}

async function fetchLinkContent(params: {
  timeoutMs: number;
  url: string;
  signal?: AbortSignal;
}): Promise<{ content: string; finalUrl: string } | null> {
  const { response, finalUrl, release } = await fetchWithSsrFGuard({
    url: params.url,
    timeoutMs: params.timeoutMs,
    mode: GUARDED_FETCH_MODE.STRICT,
    auditContext: "link-understanding",
    signal: params.signal,
    init: {
      headers: {
        Accept: "text/*,application/json,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "User-Agent": "OpenClaw-LinkUnderstanding/1.0",
      },
    },
  });
  try {
    if (!response.ok) {
      // Do not await: a debug-capture tee settles only after its sibling branch cancels.
      void cancelUnreadResponseBody(response);
      throw new Error(`Link fetch failed with HTTP ${response.status}`);
    }
    const buffer = await readResponseWithLimit(response, CLI_OUTPUT_MAX_BUFFER);
    const content = new TextDecoder().decode(buffer).trim();
    if (!content) {
      return null;
    }
    return { content, finalUrl };
  } finally {
    await release();
  }
}

/**
 * Fetches detected links through the SSRF guard and runs configured CLI processors.
 */
export async function runLinkUnderstanding(params: {
  cfg: OpenClawConfig;
  ctx: MsgContext;
  message?: string;
  signal?: AbortSignal;
}): Promise<string[]> {
  const config = params.cfg.tools?.links;
  if (!config || config.enabled === false) {
    return [];
  }

  const scopeDecision = resolveScopeDecision({ scope: config.scope, ctx: params.ctx });
  if (scopeDecision === "deny") {
    if (shouldLogVerbose()) {
      logVerbose("Link understanding disabled by scope policy.");
    }
    return [];
  }

  const message = params.message ?? params.ctx.CommandBody ?? params.ctx.RawBody ?? params.ctx.Body;
  const links = extractLinksFromMessage(message ?? "", { maxLinks: config?.maxLinks });
  if (links.length === 0) {
    return [];
  }

  const entries = config?.models ?? [];
  if (entries.length === 0) {
    return [];
  }

  const outputs: string[] = [];
  // Fetch honors the global timeout, or the slowest configured processor.
  const timeoutMs =
    config.timeoutSeconds != null
      ? resolveTimeoutMs(config.timeoutSeconds, DEFAULT_LINK_TIMEOUT_SECONDS)
      : Math.max(
          ...entries.map((entry) =>
            resolveTimeoutMs(entry.timeoutSeconds, DEFAULT_LINK_TIMEOUT_SECONDS),
          ),
        );
  for (const url of links) {
    if (params.signal?.aborted) {
      break;
    }
    let fetched: Awaited<ReturnType<typeof fetchLinkContent>>;
    try {
      fetched = await fetchLinkContent({ url, timeoutMs, signal: params.signal });
    } catch (err) {
      if (params.signal?.aborted) {
        throw createAbortError("Link understanding fetch aborted", { cause: params.signal.reason });
      }
      if (isAbortError(err)) {
        throw err;
      }
      if (shouldLogVerbose()) {
        logVerbose(`Link understanding fetch blocked or failed for ${url}: ${String(err)}`);
      }
      continue;
    }
    if (!fetched) {
      continue;
    }
    let output: string | undefined;
    let lastError: unknown;
    for (const entry of entries) {
      if (params.signal?.aborted) {
        break;
      }
      try {
        if ((entry.type ?? "cli") !== "cli") {
          continue;
        }
        const command = entry.command.trim();
        if (!command) {
          continue;
        }
        const args = entry.args ?? [];
        const name = (command.split(/[\\/]/).pop() ?? command).toLowerCase();
        if ((name === "curl" || name === "wget") && args.some(isLinkUrlTemplate)) {
          // Guarded fetch already supplied content for these fetch-only entries.
          output = fetched.content;
          break;
        }
        const templCtx = { ...params.ctx };
        const argv = [
          command,
          ...args
            .filter((arg) => !isLinkUrlTemplate(arg))
            .map((arg) => applyTemplate(arg, templCtx)),
        ];
        if (shouldLogVerbose()) {
          logVerbose(`Link understanding via CLI: ${argv.join(" ")}`);
        }
        const result = await runCommandWithTimeout(argv, {
          timeoutMs: resolveTimeoutMs(
            entry.timeoutSeconds ?? config.timeoutSeconds,
            DEFAULT_LINK_TIMEOUT_SECONDS,
          ),
          input: fetched.content,
          signal: params.signal,
          // Processor descendants share the reply's cancellation lifetime.
          killProcessTree: true,
          env: { OPENCLAW_LINK_FINAL_URL: fetched.finalUrl, OPENCLAW_LINK_URL: url },
        });
        if (params.signal?.aborted) {
          throw createAbortError("Link understanding command aborted", {
            cause: params.signal.reason,
          });
        }
        if (result.code !== 0) {
          throw new Error(
            `Link understanding command exited with code ${result.code ?? "unknown"}`,
          );
        }
        output = result.stdout.trim();
        if (output) {
          break;
        }
      } catch (err) {
        if (isAbortError(err)) {
          throw err;
        }
        lastError = err;
        if (shouldLogVerbose()) {
          logVerbose(`Link understanding failed for ${url}: ${String(err)}`);
        }
      }
    }
    if (!output && lastError && shouldLogVerbose()) {
      logVerbose(`Link understanding exhausted for ${url}`);
    }
    if (params.signal?.aborted) {
      break;
    }
    outputs.push(output || fetched.content);
  }

  return outputs;
}
