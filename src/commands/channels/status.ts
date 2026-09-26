// Implements `openclaw channels status` with gateway status and config-only fallback.
import { redactSensitiveUrlLikeString } from "@openclaw/net-policy/redact-sensitive-url";
import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import { DEFAULT_RESTART_HEALTH_TIMEOUT_MS } from "../../cli/daemon-cli/restart-health.constants.js";
import {
  formatCliFailureLines,
  isExpectedCliError,
  isGatewayCredentialsCliError,
} from "../../cli/failure-output.js";
import { parseTimeoutMsWithFallback } from "../../cli/parse-timeout.js";
import { withProgress } from "../../cli/progress.js";
import { callGateway } from "../../gateway/call.js";
import { isGatewaySecretRefUnavailableError } from "../../gateway/credentials.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { defaultRuntime, type RuntimeEnv, writeRuntimeJson } from "../../runtime.js";
import { createLazyRuntimeModule } from "../../shared/lazy-runtime.js";
import { waitForGatewayDiagnostic } from "../gateway-diagnostic-readiness.js";

const loadChannelsStatusRuntime = createLazyRuntimeModule(() => import("./status.runtime.js"));

export type ChannelsStatusOptions = {
  channel?: string;
  json?: boolean;
  probe?: boolean;
  timeout?: string;
};

function redactGatewayUrlSecretsInText(text: string): string {
  return text.replace(/\b(?:wss?|https?):\/\/[^\s"'<>]+/gi, (rawUrl) => {
    return redactSensitiveUrlLikeString(rawUrl);
  });
}

/** Query gateway channel status, falling back to config-only output when unavailable. */
export async function channelsStatusCommand(
  opts: ChannelsStatusOptions,
  runtime: RuntimeEnv = defaultRuntime,
) {
  const args =
    normalizeOptionalLowercaseString(opts.channel) === "all"
      ? { ...opts, channel: undefined }
      : opts;
  const timeoutMs = parseTimeoutMsWithFallback(opts.timeout, DEFAULT_RESTART_HEALTH_TIMEOUT_MS, {
    invalidType: "error",
  });
  const statusLabel = opts.probe ? "Checking channel status (probe)…" : "Checking channel status…";
  const shouldLogStatus = opts.json !== true && !process.stderr.isTTY;
  if (shouldLogStatus) {
    runtime.log(statusLabel);
  }
  try {
    const remainingMs = await waitForGatewayDiagnostic({ timeoutMs, json: opts.json }, runtime);
    if (remainingMs === undefined) {
      return;
    }
    const payload = await withProgress(
      {
        label: statusLabel,
        indeterminate: true,
        enabled: opts.json !== true,
      },
      async () => {
        const params: { channel?: string; probe: boolean; timeoutMs: number } = {
          probe: Boolean(opts.probe),
          timeoutMs: remainingMs,
        };
        if (args.channel) {
          params.channel = args.channel;
        }
        return await callGateway({
          method: "channels.status",
          params,
          timeoutMs: remainingMs,
          sharedStateMode: "read-only",
        });
      },
    );
    if (opts.json) {
      writeRuntimeJson(runtime, payload);
      return;
    }
    const { formatGatewayChannelsStatusLines } = await loadChannelsStatusRuntime();
    runtime.log(formatGatewayChannelsStatusLines(payload).join("\n"));
  } catch (err) {
    const safeError = redactGatewayUrlSecretsInText(formatErrorMessage(err));
    const expectedError = isExpectedCliError(err);
    const gatewayAuthUnavailable =
      isGatewayCredentialsCliError(err) || isGatewaySecretRefUnavailableError(err);
    const expectedErrorOutput = expectedError
      ? formatCliFailureLines({ title: "", error: err }).join("\n")
      : undefined;
    const { renderChannelsStatusFallback } = await loadChannelsStatusRuntime();
    await renderChannelsStatusFallback({
      opts: args,
      runtime,
      safeError,
      gatewayAuthUnavailable,
      expectedErrorOutput,
    });
  }
}
