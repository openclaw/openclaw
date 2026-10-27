// Downloads generated video assets under provider-owned transport policies.
import { maxBytesForKind } from "@openclaw/media-core/constants";
import { extensionForMime } from "@openclaw/media-core/mime";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  assertOkOrThrowHttpError,
  readProviderBinaryResponse,
} from "../agents/provider-http-errors.js";
import { readResponseWithLimit } from "../infra/http-body.js";
import type { PinnedDispatcherPolicy } from "../infra/net/ssrf.js";
import {
  createProviderOperationDeadline,
  createProviderOperationTimeoutError,
  createProviderOperationTimeoutResolver,
  fetchWithTimeoutGuarded,
  type ProviderOperationDeadline,
  type ProviderOperationTimeoutMs,
} from "../media-understanding/shared.js";
import { executeProviderOperationWithRetry } from "../provider-runtime/operation-retry.js";
import type { GeneratedVideoAsset } from "../video-generation/types.js";

type GeneratedVideoResponseHandle = {
  response: Response;
  release?: () => Promise<void>;
};

type GeneratedVideoResponseFactory = (params: {
  deadline: ProviderOperationDeadline;
  timeoutMs: () => number;
}) => Promise<GeneratedVideoResponseHandle>;

/** Read a generated video, optionally delivering its remote URL when it exceeds the byte cap. */
export async function readGeneratedVideoAsset(
  response: Response,
  params: {
    label: string;
    maxBytes?: number;
    index?: number;
    validateBinaryResponse?: boolean;
    overflowUrl?: string;
    readOptions?: Omit<
      NonNullable<Parameters<typeof readProviderBinaryResponse>[3]>,
      "maxBytes" | "onOverflow"
    >;
  },
): Promise<GeneratedVideoAsset> {
  const mimeType = normalizeOptionalString(response.headers.get("content-type")) ?? "video/mp4";
  const ext = extensionForMime(mimeType)?.replace(/^\./u, "") ?? "mp4";
  const asset = { mimeType, fileName: `video-${(params.index ?? 0) + 1}.${ext}` };
  const maxBytes = params.maxBytes ?? maxBytesForKind("video");
  let exceededMaxBytes = false;
  const readOptions = {
    ...params.readOptions,
    maxBytes,
    onOverflow: ({ maxBytes: limit }: { maxBytes: number }) => {
      exceededMaxBytes = true;
      return new Error(`${params.label} exceeds ${limit} bytes`);
    },
  };
  try {
    const buffer = params.validateBinaryResponse
      ? await readProviderBinaryResponse(response, params.label, "video", readOptions)
      : await readResponseWithLimit(response, maxBytes, readOptions);
    return { buffer, ...asset };
  } catch (error) {
    if (exceededMaxBytes && params.overflowUrl) {
      return { url: params.overflowUrl, ...asset };
    }
    throw error;
  }
}

/** Download a generated video URL with size limits and inferred video metadata. */
export async function downloadGeneratedVideoAsset(params: {
  url: string;
  timeoutMs: ProviderOperationTimeoutMs;
  defaultTimeoutMs: number;
  fetchFn: typeof fetch;
  provider: string;
  label: string;
  requestFailedMessage: string;
  index?: number;
  maxBytes?: number;
  validateBinaryResponse?: boolean;
  /** Zero preserves deadline-only downloads without adding an idle timeout. */
  chunkTimeoutMs?: number;
  metadata?: Record<string, unknown>;
  /** Result transport only; strict target admission never inherits task trust. */
  dispatcherPolicy?: PinnedDispatcherPolicy;
  fetchResponse?: GeneratedVideoResponseFactory;
}): Promise<GeneratedVideoAsset> {
  const deadline = createProviderOperationDeadline({
    timeoutMs: params.timeoutMs,
    label: params.label,
  });
  const timeoutMs = createProviderOperationTimeoutResolver({
    deadline,
    defaultTimeoutMs: deadline.timeoutMs ?? params.defaultTimeoutMs,
  });
  const handle = params.fetchResponse
    ? await params.fetchResponse({ deadline, timeoutMs })
    : await executeProviderOperationWithRetry({
        provider: params.provider,
        stage: "download",
        operation: async () => {
          // Keep result DNS checks strict while retaining environment-proxy transport.
          const result = await fetchWithTimeoutGuarded(
            params.url,
            { method: "GET" },
            timeoutMs(),
            params.fetchFn,
            {
              mode: "strict",
              dispatcherPolicy: params.dispatcherPolicy ?? { mode: "env-proxy" },
            },
          );
          try {
            await assertOkOrThrowHttpError(result.response, params.requestFailedMessage, {
              bodyTimeoutMs: timeoutMs,
              onBodyTimeout: () => createProviderOperationTimeoutError(deadline),
            });
            return result;
          } catch (error) {
            await result.release();
            throw error;
          }
        },
      });
  try {
    const asset = await readGeneratedVideoAsset(handle.response, {
      label: params.label,
      maxBytes: params.maxBytes,
      index: params.index,
      validateBinaryResponse: params.validateBinaryResponse,
      readOptions: {
        chunkTimeoutMs: params.chunkTimeoutMs,
        timeoutMs,
        onTimeout: ({ timeoutMs: bodyTimeoutMs }) =>
          new Error(`${params.label} timed out after ${deadline.timeoutMs ?? bodyTimeoutMs}ms`),
      },
    });
    return {
      ...asset,
      ...(params.metadata ? { metadata: params.metadata } : {}),
    };
  } finally {
    await handle.release?.();
  }
}
