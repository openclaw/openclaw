import { withProgress } from "../cli/progress.js";
import { callGateway } from "../gateway/call.js";
import type { SessionsPatchResult } from "../gateway/protocol/index.js";
import { formatErrorMessage } from "../infra/errors.js";
import { type RuntimeEnv, writeRuntimeJson } from "../runtime.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";

const DEFAULT_TIMEOUT_MS = 15_000;

function isSessionsResolveNotFoundError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : typeof err === "string" ? err : "";
  return message.trimStart().startsWith("No session found:");
}

export type SessionsLabelCommandOpts = {
  session: string;
  label?: string;
  clear?: boolean;
  force?: boolean;
  json?: boolean;
  url?: string;
  token?: string;
  password?: string;
  timeout?: unknown;
};

export async function sessionsLabelCommand(opts: SessionsLabelCommandOpts, runtime: RuntimeEnv) {
  const sessionKey = opts.session?.trim();
  if (!sessionKey) {
    runtime.error("--session is required");
    runtime.exit(1);
    return;
  }

  const clear = opts.clear === true;
  const rawLabel = typeof opts.label === "string" ? opts.label.trim() : "";
  if (clear && rawLabel) {
    runtime.error("Pass either --clear or a label, not both");
    runtime.exit(1);
    return;
  }
  if (!clear && !rawLabel) {
    runtime.error("Pass a label string or use --clear to remove the label");
    runtime.exit(1);
    return;
  }

  const timeoutRaw = opts.timeout;
  const timeoutMs =
    typeof timeoutRaw === "number" && Number.isFinite(timeoutRaw) && timeoutRaw > 0
      ? Math.floor(timeoutRaw)
      : typeof timeoutRaw === "string" && /^\d+$/.test(timeoutRaw.trim())
        ? Number.parseInt(timeoutRaw.trim(), 10)
        : DEFAULT_TIMEOUT_MS;

  if (opts.force !== true) {
    try {
      await callGateway<{ ok: true; key: string }>({
        method: "sessions.resolve",
        params: {
          key: sessionKey,
          includeGlobal: true,
          includeUnknown: true,
        },
        clientName: GATEWAY_CLIENT_NAMES.CLI,
        mode: GATEWAY_CLIENT_MODES.CLI,
        url: opts.url?.trim() || undefined,
        token: opts.token?.trim() || undefined,
        password: opts.password?.trim() || undefined,
        timeoutMs,
      });
    } catch (err) {
      if (isSessionsResolveNotFoundError(err)) {
        runtime.error(
          `Unknown session key: ${sessionKey}. Run "openclaw sessions" to find the correct key, or pass --force to create a new entry.`,
        );
        runtime.exit(1);
        return;
      }
      const message = formatErrorMessage(err);
      runtime.error(message);
      runtime.exit(1);
      return;
    }
  }

  const run = async () =>
    await callGateway<SessionsPatchResult>({
      method: "sessions.patch",
      params: {
        key: sessionKey,
        label: clear ? null : rawLabel,
      },
      clientName: GATEWAY_CLIENT_NAMES.CLI,
      mode: GATEWAY_CLIENT_MODES.CLI,
      url: opts.url?.trim() || undefined,
      token: opts.token?.trim() || undefined,
      password: opts.password?.trim() || undefined,
      timeoutMs,
    });

  try {
    const result = opts.json
      ? await run()
      : await withProgress(
          {
            label: "Updating session label…",
            indeterminate: true,
            enabled: true,
          },
          run,
        );

    if (opts.json) {
      writeRuntimeJson(runtime, result);
      return;
    }

    const key = result.key ?? sessionKey;
    const entryLabel = result.entry?.label;
    if (clear) {
      runtime.log(`Cleared label for ${key}`);
    } else {
      runtime.log(`Set label for ${key}: ${entryLabel ?? rawLabel}`);
    }
  } catch (err) {
    const message = formatErrorMessage(err);
    runtime.error(message);
    runtime.exit(1);
  }
}
