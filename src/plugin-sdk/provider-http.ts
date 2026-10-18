// Shared provider-facing HTTP helpers. Keep generic transport utilities here so
// capability SDKs do not depend on each other.

import { resolveProviderHttpRequestConfig } from "../media-understanding/shared.js";

type ProviderApiKeyRequest = {
  cfg?: Parameters<typeof import("./provider-auth-runtime.js").resolveApiKeyForProvider>[0]["cfg"];
  agentDir?: string;
  authStore?: Parameters<
    typeof import("./provider-auth-runtime.js").resolveApiKeyForProvider
  >[0]["store"];
};

/** Resolve current provider auth and the common Bearer-authenticated HTTP request policy. */
export async function resolveProviderApiKeyHttpRequestConfig(
  params: Omit<Parameters<typeof resolveProviderHttpRequestConfig>[0], "transport"> & {
    provider: string;
    req: ProviderApiKeyRequest;
    missingApiKeyMessage: string;
    jsonContentType?: boolean;
  },
) {
  const { req, missingApiKeyMessage, jsonContentType = true, ...http } = params;
  const { resolveApiKeyForProvider } = await import("./provider-auth-runtime.js");
  const auth = await resolveApiKeyForProvider({
    provider: http.provider,
    cfg: req.cfg,
    agentDir: req.agentDir,
    store: req.authStore,
  });
  if (!auth.apiKey) {
    throw new Error(missingApiKeyMessage);
  }
  return resolveProviderHttpRequestConfig({
    ...http,
    transport: "http",
    defaultHeaders: {
      Authorization: `Bearer ${auth.apiKey}`,
      ...(jsonContentType ? { "Content-Type": "application/json" } : {}),
      ...http.defaultHeaders,
    },
  });
}

export {
  inspectTlsCertificateError,
  type TlsCertificateErrorDetails,
  type TlsCertificateErrorKind,
} from "@openclaw/ai/internal/shared";
export {
  assertOkOrThrowHttpError,
  assertOkOrThrowProviderError,
  assertProviderBinaryResponseContent,
  createProviderCredentialMatcher,
  createProviderHttpError,
  ProviderHttpError,
  extractProviderErrorDetail,
  extractProviderRequestId,
  formatProviderErrorPayload,
  formatProviderHttpErrorMessage,
  readProviderBinaryResponse,
  readProviderJsonArrayFieldResponse,
  readProviderJsonObjectResponse,
  readProviderJsonResponse,
  readProviderTextResponse,
  readResponseTextLimited,
  truncateErrorDetail,
} from "../agents/provider-http-errors.js";
export {
  readProviderResponseErrorText,
  redactProviderResponseErrorText,
} from "../agents/provider-request-header-redaction.js";
export {
  buildAudioTranscriptionFormData,
  createProviderOperationDeadline,
  createProviderOperationTimeoutError,
  createProviderOperationTimeoutResolver,
  fetchProviderDownloadResponse,
  fetchProviderOperationResponse,
  fetchWithTimeout,
  fetchWithTimeoutGuarded,
  normalizeBaseUrl,
  pollProviderOperation,
  pollProviderOperationJson,
  postJsonRequest,
  postMultipartRequest,
  postTranscriptionRequest,
  resolveProviderOperationTimeoutMs,
  resolveProviderHttpRequestConfig,
  resolveProviderHttpRequestConfigWithOriginTrust,
  resolveAudioTranscriptionUploadFileName,
  requireTranscriptionText,
  sanitizeConfiguredModelProviderRequest,
  waitProviderOperationPollInterval,
} from "../media-understanding/shared.js";
export { postJsonResponse } from "../media-understanding/provider-json-post.js";
export { openProviderWebSocket } from "../infra/net/provider-websocket.js";
export {
  runHttpTlsPreflight,
  type HttpTlsPreflightOptions,
  type HttpTlsPreflightResult,
} from "../infra/http-tls-preflight.js";
export type {
  ProviderOperationDeadline,
  ProviderOperationTimeoutMs,
} from "../media-understanding/shared.js";
export {
  executeProviderOperationWithRetry,
  providerOperationRetryConfig,
} from "../provider-runtime/operation-retry.js";
export type {
  ProviderOperationRetryStage,
  TransientProviderRetryConfig,
  TransientProviderRetryOptions,
  TransientProviderRetryParams,
} from "../provider-runtime/operation-retry.js";
export type {
  ProviderAttributionPolicy,
  ProviderRequestCapabilities,
  ProviderRequestCapabilitiesInput,
  ProviderRequestCompatibilityFamily,
  ProviderEndpointClass,
  ProviderEndpointResolution,
  ProviderRequestCapability,
  ProviderRequestPolicyInput,
  ProviderRequestPolicyResolution,
  ProviderRequestTransport,
} from "../agents/provider-attribution.js";
export type {
  ProviderRequestAuthOverride,
  ProviderRequestProxyOverride,
  ProviderRequestTlsOverride,
  ProviderRequestTransportOverrides,
} from "../agents/provider-request-config.types.js";
export { resolveProviderRequestHeaders } from "../agents/provider-request-config.js";
export { resolveProviderTransportSsrFPolicy } from "../agents/provider-network-policy.js";
export { fetchWithProviderHttpGuard } from "../agents/provider-transport-dispatcher-pool.js";
export {
  resolveProviderEndpoint,
  resolveProviderRequestCapabilities,
  resolveProviderRequestPolicy,
} from "../agents/provider-attribution.js";
