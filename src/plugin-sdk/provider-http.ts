// Shared provider-facing HTTP helpers. Keep generic transport utilities here so
// capability SDKs do not depend on each other.
export { warnPluginSdkDeprecation } from "../plugins/sdk-deprecation.js";

export {
  inspectTlsCertificateError,
  type TlsCertificateErrorDetails,
  type TlsCertificateErrorKind,
} from "@openclaw/ai/internal/shared";
export {
  assertOkOrThrowHttpError,
  assertOkOrThrowProviderError,
  assertProviderBinaryResponseContent,
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
export {
  getModelProviderRequestRouteFacts,
  prepareModelProviderRequestRouteFacts,
  resolveProviderRequestHeadersAsync,
} from "../agents/provider-request-config.js";
export {
  resolveProviderEndpointLegacy as resolveProviderEndpoint,
  resolveProviderRequestCapabilitiesLegacy as resolveProviderRequestCapabilities,
  resolveProviderRequestPolicyLegacy as resolveProviderRequestPolicy,
  resolveProviderRequestHeadersLegacy as resolveProviderRequestHeaders,
} from "../agents/provider-attribution-sdk.js";
