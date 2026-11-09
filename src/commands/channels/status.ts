import { redactSensitiveUrlLikeString } from "@openclaw/net-policy/redact-sensitive-url";
import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import { isGatewayProtocolResponseError } from "../../../packages/gateway-client/src/protocol-request.js";
import { DEFAULT_RESTART_HEALTH_TIMEOUT_MS } from "../../cli/daemon-cli/restart-health.constants.js";
import {
  formatCliFailureLines,
  isExpectedCliError,
  isGatewayCredentialsCliError,
} from "../../cli/failure-output.js";
import { prepareCliGatewayStateAccess } from "../../cli/gateway-rpc.runtime.js";
import { parseTimeoutMsWithFallback } from "../../cli/parse-timeout.js";
import { withProgress } from "../../cli/progress.js";
import { callGateway } from "../../gateway/call.js";
import { isGatewaySecretRefUnavailableError } from "../../gateway/credentials.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { defaultRuntime, ExitError, type RuntimeEnv, writeRuntimeJson } from "../../runtime.js";
import { waitForGatewayDiagnostic } from "../gateway-diagnostic-readiness.js";

export type ChannelsStatusOptions = {
  channel?: string;
  json?: boolean;
  probe?: boolean;
  timeout?: string;
  failOnUnhealthy?: boolean;
  exitCode?: boolean;
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
  const statusLabel = opts.probe ? "Checking channel connections…" : "Checking channel status…";
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
          beforeDeviceIdentityLoad: prepareCliGatewayStateAccess,
        });
      },
    );
    const failOnUnhealthy = opts.failOnUnhealthy === true || opts.exitCode === true;
    // Load the health evaluator only when the opt-in flag is set, keeping the
    // plain status path cold (see channels-status-cold-imports).
    const unhealthyHelpers = failOnUnhealthy ? await import("./status-unhealthy.js") : null;
    const unhealthyAccounts = unhealthyHelpers?.collectUnhealthyChannelAccounts(payload) ?? [];
    if (opts.json) {
      if (failOnUnhealthy) {
        const output =
          payload && typeof payload === "object" && !Array.isArray(payload)
            ? { ...(payload as Record<string, unknown>), unhealthyAccounts }
            : payload;
        writeRuntimeJson(runtime, output);
      } else {
        writeRuntimeJson(runtime, payload);
      }
    } else {
      const { formatGatewayChannelsStatusLines } = await import("./status.runtime.js");
      runtime.log(formatGatewayChannelsStatusLines(payload).join("\n"));
    }
    if (unhealthyAccounts.length > 0) {
      for (const account of unhealthyAccounts) {
        runtime.error(unhealthyHelpers!.formatUnhealthyChannelAccount(account));
      }
      runtime.exit(1);
    }
  } catch (err) {
    if (err instanceof ExitError) {
      throw err;
    }
    if (isGatewayProtocolResponseError(err)) {
      throw err;
    }
    const safeError = redactGatewayUrlSecretsInText(formatErrorMessage(err));
    const expectedError = isExpectedCliError(err);
    const gatewayAuthUnavailable =
      isGatewayCredentialsCliError(err) || isGatewaySecretRefUnavailableError(err);
    const expectedErrorOutput = expectedError
      ? formatCliFailureLines({ title: "", error: err }).join("\n")
      : undefined;
    const { renderChannelsStatusFallback } = await import("./status.runtime.js");
    await renderChannelsStatusFallback({
      opts: args,
      runtime,
      safeError,
      gatewayAuthUnavailable,
      expectedErrorOutput,
    });
  }
}
