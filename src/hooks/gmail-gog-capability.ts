// Gmail gog capability checks keep pull delivery from respawning unsupported gog builds.
import { runCommandWithTimeout } from "../process/exec.js";
import {
  buildGogWatchPullHelpArgs,
  type GmailHookRuntimeConfig,
  isGmailHookPullRuntimeConfig,
  resolveGogExecutable,
} from "./gmail.js";

const GOG_PULL_HELP_TIMEOUT_MS = 30_000;
const GOG_PULL_HELP_OUTPUT_BYTES = 64 * 1024;

export type GmailWatchDeliverySupportResult = { ok: true } | { ok: false; error: string };

export async function checkGmailWatchDeliverySupported(
  cfg: GmailHookRuntimeConfig,
  options: { signal?: AbortSignal } = {},
): Promise<GmailWatchDeliverySupportResult> {
  if (!isGmailHookPullRuntimeConfig(cfg)) {
    return { ok: true };
  }

  const result = await runCommandWithTimeout(
    [resolveGogExecutable(), ...buildGogWatchPullHelpArgs()],
    {
      timeoutMs: GOG_PULL_HELP_TIMEOUT_MS,
      maxOutputBytes: GOG_PULL_HELP_OUTPUT_BYTES,
      signal: options.signal,
    },
  );
  if (result.code === 0) {
    return { ok: true };
  }

  const detail = (result.stderr || result.stdout || "gog gmail watch pull --help failed").trim();
  return {
    ok: false,
    error: `gog gmail watch pull is unavailable; install gogcli with Pub/Sub pull support. ${detail}`,
  };
}
