import { inspectTlsCertificateError } from "@openclaw/ai/internal/shared";
import { resolveTimerTimeoutMs } from "@openclaw/normalization-core/number-coercion";
import { asNullableObjectRecord } from "@openclaw/normalization-core/record-coerce";
import { cancelUnreadResponseBody } from "./http-response-body.js";

export type HttpTlsPreflightResult =
  | { ok: true }
  | { ok: false; kind: "tls-cert" | "network"; code?: string; message: string };

export type HttpTlsPreflightOptions = {
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  assertCurrent?: () => void;
};

/** Probe reachability without following redirects or consuming the response body. */
export async function runHttpTlsPreflight(
  url: string,
  options: HttpTlsPreflightOptions = {},
): Promise<HttpTlsPreflightResult> {
  const timeoutMs = resolveTimerTimeoutMs(options.timeoutMs, 5000);
  const fetchImpl = options.fetchImpl ?? fetch;
  options.signal?.throwIfAborted();
  options.assertCurrent?.();
  let response: Response | undefined;
  try {
    response = await fetchImpl(url, {
      method: "GET",
      redirect: "manual",
      signal: options.signal
        ? AbortSignal.any([options.signal, AbortSignal.timeout(timeoutMs)])
        : AbortSignal.timeout(timeoutMs),
    });
    return { ok: true };
  } catch (error) {
    options.signal?.throwIfAborted();
    options.assertCurrent?.();
    const tlsFailure = inspectTlsCertificateError(error);
    if (tlsFailure) {
      return {
        ok: false,
        kind: "tls-cert",
        code: tlsFailure.code,
        message: tlsFailure.message,
      };
    }
    const root = asNullableObjectRecord(error);
    const cause = asNullableObjectRecord(root?.cause);
    return {
      ok: false,
      kind: "network",
      code: typeof cause?.code === "string" ? cause.code : undefined,
      message:
        typeof cause?.message === "string"
          ? cause.message
          : typeof root?.message === "string"
            ? root.message
            : String(error),
    };
  } finally {
    await cancelUnreadResponseBody(response);
  }
}
