import { fetchWithSsrFGuard, GUARDED_FETCH_MODE } from "../../infra/net/fetch-guard.js";
import { shouldUseEnvHttpProxyForUrl } from "../../infra/net/proxy-env.js";
import { ssrfPolicyFromHttpBaseUrlAllowedHostname, type SsrFPolicy } from "../../infra/net/ssrf.js";

export const buildRemoteBaseUrlPolicy = ssrfPolicyFromHttpBaseUrlAllowedHostname;

function sanitizeUrlForError(value: string): string {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  } catch {
    return "<invalid-url>";
  }
}

function sanitizeErrorMessage(message: string): string {
  return message
    .replace(/https?:\/\/[^\s"'<>]+/g, (match) => sanitizeUrlForError(match))
    .replace(/Bearer\s+[^\s"'<>]+/gi, "Bearer [redacted]");
}

function getErrorMessage(value: unknown): string {
  if (value instanceof Error) {
    return value.message;
  }
  return String(value);
}

function getCauseDetails(err: unknown): string | null {
  const cause = (err as { cause?: unknown } | null | undefined)?.cause;
  if (!cause || typeof cause !== "object") {
    return null;
  }
  const name = (cause as { name?: unknown }).name;
  const message = (cause as { message?: unknown }).message;
  const code = (cause as { code?: unknown }).code;
  const parts = [
    typeof name === "string" && name ? name : null,
    typeof message === "string" && message ? sanitizeErrorMessage(message) : null,
    typeof code === "string" && code ? `code: ${code}` : null,
  ].filter((part): part is string => Boolean(part));
  return parts.length ? parts.join("; ") : null;
}

function wrapRemoteTransportError(params: {
  err: unknown;
  url: string;
  auditContext: string;
}): Error {
  let message = `${params.auditContext} request to ${sanitizeUrlForError(
    params.url,
  )} failed: ${sanitizeErrorMessage(getErrorMessage(params.err))}`;
  const causeDetails = getCauseDetails(params.err);
  if (causeDetails) {
    message += ` (cause: ${causeDetails})`;
  }
  return new Error(message, { cause: params.err });
}

export async function withRemoteHttpResponse<T>(params: {
  url: string;
  init?: RequestInit;
  ssrfPolicy?: SsrFPolicy;
  fetchImpl?: typeof fetch;
  auditContext?: string;
  onResponse: (response: Response) => Promise<T>;
}): Promise<T> {
  const auditContext = params.auditContext ?? "memory-remote";
  let guardedResponse;
  try {
    guardedResponse = await fetchWithSsrFGuard({
      url: params.url,
      fetchImpl: params.fetchImpl,
      init: params.init,
      policy: params.ssrfPolicy,
      auditContext,
      ...(shouldUseEnvHttpProxyForUrl(params.url)
        ? { mode: GUARDED_FETCH_MODE.TRUSTED_ENV_PROXY }
        : {}),
    });
  } catch (err) {
    throw wrapRemoteTransportError({ err, url: params.url, auditContext });
  }
  const { response, release } = guardedResponse;
  try {
    return await params.onResponse(response);
  } finally {
    await release();
  }
}
