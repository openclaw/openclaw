// Shared provider-facing HTTP helpers. Keep generic transport utilities here so
// capability SDKs do not depend on each other.

export {
  assertOkOrThrowHttpError,
  fetchWithTimeout,
  fetchWithTimeoutGuarded,
  normalizeBaseUrl,
  postJsonRequest,
  postTranscriptionRequest,
  requireTranscriptionText,
} from "../media-understanding/shared.js";
