import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  createClawHubError,
  isClawHubTelemetryDisabled,
  resolveClawHubAuthToken,
  withClawHubResponse,
  type ClawHubFetchOptions,
} from "./clawhub-client.js";

export async function reportClawHubInstallTelemetry(
  params: ClawHubFetchOptions,
  buildEvent: () => Record<string, unknown> | undefined,
): Promise<void> {
  const token = normalizeOptionalString(params.token) ?? (await resolveClawHubAuthToken());
  if (!token || isClawHubTelemetryDisabled()) {
    return;
  }
  const json = buildEvent();
  if (!json) {
    return;
  }
  await withClawHubResponse(
    {
      baseUrl: params.baseUrl,
      path: "/api/cli/telemetry/install",
      method: "POST",
      token,
      timeoutMs: params.timeoutMs,
      fetchImpl: params.fetchImpl,
      json,
    },
    async ({ response, url, hasToken }) => {
      if (!response.ok) {
        throw await createClawHubError(response, url, hasToken, params.timeoutMs);
      }
    },
  );
}
