import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";

// Provider codes are machine tokens (invalid_api_key, insufficient_quota); anything else
// could carry provider-controlled prose, so it never reaches a marker or warning.
const PROVIDER_CODE = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;

/** Bounded, credential-free cause for a failed media-understanding provider call. */
export function describeMediaProviderFailure(error: unknown): string | undefined {
  const record = asOptionalRecord(error);
  if (record?.name === "TimeoutError") {
    return "provider timed out";
  }
  const status = record?.status;
  if (record?.name !== "ProviderHttpError" || typeof status !== "number") {
    return undefined;
  }
  const code = [record.code, record.errorType].find(
    (value): value is string => typeof value === "string" && PROVIDER_CODE.test(value),
  );
  const detail = code ? `${status} ${code}` : String(status);
  if (status === 401 || status === 403) {
    return `provider rejected the credential (${detail})`;
  }
  if (status === 429) {
    return /quota|insufficient|billing|credit/i.test(code ?? "")
      ? `provider account is out of quota (${detail})`
      : `provider rate limited the request (${detail})`;
  }
  if (status === 408 || status === 504) {
    return `provider timed out (${detail})`;
  }
  return status >= 500
    ? `provider is unavailable (${detail})`
    : `provider rejected the request (${detail})`;
}

/** Keeps the existing `Name: message` attempt reason for errors and readable text otherwise. */
export function formatAttemptError(error: unknown): string {
  if (error instanceof Error) {
    return error.toString();
  }
  return typeof error === "string" ? error : (JSON.stringify(error) ?? "unknown error");
}
