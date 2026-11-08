import { asOptionalObjectRecord, isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  assertOkOrThrowHttpError,
  readProviderBinaryResponse,
} from "../agents/provider-http-errors.js";
import { fetchWithSsrFGuard } from "../infra/net/fetch-guard.js";
import {
  mergeSsrFPolicies,
  type PinnedDispatcherPolicy,
  type SsrFPolicy,
} from "../infra/net/ssrf.js";

/**
 * Downloads `data[].url` entries of an OpenAI-compatible image response and
 * returns the payload with each one inlined as `b64_json`, so URL and inline
 * results share one asset parser. Only the provider origin is automatically
 * trusted; other private destinations require explicit policy. Provider HTTP
 * credentials are never sent to image URLs.
 */
export async function inlineOpenAiCompatibleImageUrls(
  payload: unknown,
  params: {
    providerId: string;
    label: string;
    operation: string;
    providerUrl: string;
    maxDownloads: number;
    maxBytes: number;
    timeoutMs: () => number;
    signal?: AbortSignal;
    /** Explicit operator opt-in only; never an inferred local-provider grant. */
    allowPrivateNetwork?: boolean;
    ssrfPolicy?: SsrFPolicy;
    dispatcherPolicy?: PinnedDispatcherPolicy;
  },
): Promise<unknown> {
  if (!isRecord(payload) || !Array.isArray(payload.data)) {
    return payload;
  }
  const providerOrigin = new URL(params.providerUrl).origin;
  const dispatcherPolicy = params.dispatcherPolicy;
  // Target TLS identity and hostname overrides belong to the provider origin.
  const externalDispatcherPolicy =
    dispatcherPolicy?.mode === "explicit-proxy"
      ? { ...dispatcherPolicy, proxyTls: undefined, pinnedHostname: undefined }
      : dispatcherPolicy
        ? { ...dispatcherPolicy, connect: undefined, pinnedHostname: undefined }
        : undefined;
  const downloadOptions = {
    policy: mergeSsrFPolicies(
      params.ssrfPolicy,
      { allowedOrigins: [providerOrigin] },
      params.allowPrivateNetwork ? { allowPrivateNetwork: true } : undefined,
    ),
    resolveDispatcherPolicy: (url: URL) =>
      url.origin === providerOrigin ? dispatcherPolicy : externalDispatcherPolicy,
    useEnvProxyForEligibleUrls: true,
    auditContext: `${params.providerId}-image-download`,
  };
  const downloadLabel = `${params.label} image download`;
  const entries: unknown[] = [];
  let downloads = 0;
  for (const entry of payload.data) {
    const record = asOptionalObjectRecord(entry);
    const url =
      record && !normalizeOptionalString(record.b64_json)
        ? normalizeOptionalString(record.url)
        : undefined;
    if (!record || !url) {
      entries.push(entry);
      continue;
    }
    if (downloads >= params.maxDownloads) {
      throw new Error(`${params.operation} returned too many image URLs`);
    }
    downloads += 1;
    const { response: download, release } = await fetchWithSsrFGuard({
      ...downloadOptions,
      url,
      init: { method: "GET" },
      timeoutMs: params.timeoutMs(),
      signal: params.signal,
      fetchImpl: fetch,
    });
    try {
      await assertOkOrThrowHttpError(download, `${downloadLabel} failed`, {
        bodyTimeoutMs: params.timeoutMs,
      });
      const mimeType = download.headers.get("Content-Type")?.split(";")[0]?.trim().toLowerCase();
      if (!mimeType || !/^image\/[a-z0-9.+-]+$/.test(mimeType)) {
        void download.body?.cancel().catch(() => undefined);
        throw new Error(`${downloadLabel}: expected an image Content-Type`);
      }
      const buffer = await readProviderBinaryResponse(download, downloadLabel, "image", {
        maxBytes: params.maxBytes,
        timeoutMs: params.timeoutMs,
      });
      entries.push({ ...record, b64_json: buffer.toString("base64"), mime_type: mimeType });
    } finally {
      await release();
    }
  }
  return { ...payload, data: entries };
}
