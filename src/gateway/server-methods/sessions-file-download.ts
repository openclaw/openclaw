import { detectMime } from "@openclaw/media-core/mime";
import { canCreateArtifactDownload, createArtifactDownload } from "../artifact-download-grants.js";
import { resolveByteResponse } from "../http-byte-range.js";
import { WORKSPACE_DOWNLOAD_CHUNK_BYTES } from "../workspace-file-limits.js";
import { readSessionFileDownloadWindow } from "./session-file-download.js";
import type { createSessionFileReadAuthority } from "./session-file-read-authority.js";
import { sessionFilesError } from "./session-files-errors.js";
import { readGatewayRequestMutationAuthority } from "./session-mutation-guards.js";
import {
  downloadRepositoryArtifact,
  streamRepositoryArtifact,
} from "./session-repository-artifacts.js";
import type { resolveRepositoryWorkspaceAccess } from "./session-repository-workspace-access.js";
import type { GatewayRequestHandlerOptions } from "./types.js";
import type { LoadedSessionFiles } from "./workspace-files.js";

/** Byte transport borrows the file-route owner's exact session, repository and host grants. */
export async function respondSessionFileDownload(params: {
  options: GatewayRequestHandlerOptions;
  path: string;
  loaded: LoadedSessionFiles;
  repository: Awaited<ReturnType<typeof resolveRepositoryWorkspaceAccess>>;
  hostRead: ReturnType<typeof createSessionFileReadAuthority>;
  assertSessionCurrent: () => void;
  release: () => void;
  onGrantCreated: () => void;
}): Promise<void> {
  const { options, repository, hostRead } = params;
  const { respond } = options;
  if (!canCreateArtifactDownload(options.client)) {
    respond(
      false,
      undefined,
      sessionFilesError(
        "session_file_download_unavailable",
        "File downloads require a live Gateway connection.",
      ),
    );
    return;
  }
  const authority = readGatewayRequestMutationAuthority(options);
  const assertCurrent = () => {
    authority.assertCurrent();
    params.assertSessionCurrent();
    repository?.assertCurrent();
    hostRead.assertCurrent();
  };
  const read = (offset?: number, identity?: string) =>
    repository?.kind === "active"
      ? repository.inspect(
          "download",
          {
            files: params.loaded.files,
            path: params.path,
            offset,
            identity,
          },
          assertCurrent,
        )
      : readSessionFileDownloadWindow({
          ...params.loaded,
          path: params.path,
          offset,
          identity,
          authorizeHostRead: hostRead.authorizeHostRead,
          assertCurrent,
        });
  const prepare = () =>
    repository?.kind === "stored" ? downloadRepositoryArtifact(repository, params.path) : read();
  const initial = await prepare();
  assertCurrent();
  if (initial.status === "missing") {
    respond(
      false,
      undefined,
      sessionFilesError("session_file_not_found", "session file not found", { path: params.path }),
    );
    return;
  }
  const { filename, size, identity } = initial;
  const mimeType = (await detectMime({ filePath: filename })) ?? "application/octet-stream";
  const artifact = {
    id: identity,
    type: "file",
    title: filename,
    mimeType,
    sizeBytes: size,
    download: { mode: "url" as const },
  };
  const publish = () => {
    assertCurrent();
    const download = createArtifactDownload({
      client: options.client,
      prepared: { artifact, digest: identity },
      assertCurrent,
      release: params.release,
      read: async (request) => {
        const current = await prepare();
        assertCurrent();
        if (current.status !== "ok" || current.identity !== request.expectedDigest) {
          return undefined;
        }
        const response = resolveByteResponse({
          file: { size },
          method: request.method,
          request: { headers: request.headers, headersDistinct: {} },
        });
        const result = () => ({
          artifact,
          response,
          ...(request.method === "HEAD" ||
          response.kind === "not-modified" ||
          response.kind === "unsatisfiable"
            ? {}
            : {
                async *stream(signal: AbortSignal) {
                  const start = response.kind === "partial" ? response.range.start : 0;
                  const end = response.kind === "partial" ? response.range.end + 1 : size;
                  if (repository?.kind === "stored") {
                    yield* streamRepositoryArtifact(repository, identity, start, end, signal);
                    return;
                  }
                  for (let offset = start; offset < end;) {
                    signal.throwIfAborted();
                    assertCurrent();
                    const window = await read(offset, identity);
                    signal.throwIfAborted();
                    assertCurrent();
                    if (window.status !== "ok" || window.identity !== identity) {
                      throw new Error("Session file became unavailable during download.");
                    }
                    const bytes = Buffer.from(window.data, "base64");
                    if (bytes.length !== Math.min(WORKSPACE_DOWNLOAD_CHUNK_BYTES, size - offset)) {
                      throw new Error("Session file download returned an incomplete byte window.");
                    }
                    yield bytes.subarray(0, end - offset);
                    offset += bytes.length;
                  }
                },
              }),
        });
        return hostRead.hasHostRead() ? hostRead.withCurrent(result) : result();
      },
    });
    params.onGrantCreated();
    respond(true, { filename, mimeType, ...download });
  };
  if (hostRead.hasHostRead()) {
    await hostRead.withCurrent(publish);
  } else {
    publish();
  }
}
