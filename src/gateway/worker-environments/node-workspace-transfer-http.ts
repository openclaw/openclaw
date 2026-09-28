import fs from "node:fs";
import fsp from "node:fs/promises";
import type { ServerResponse } from "node:http";
import { pipeline } from "node:stream/promises";
import { constants as zlibConstants, createGzip } from "node:zlib";
import { resolveHttpContentEncodings } from "../../infra/http-content-encoding.js";
import { readWorkspaceTransferBody } from "../../worker/node-workspace-transfer-body.js";
import { NODE_WORKSPACE_TRANSFER_PATH } from "../../worker/node-workspace-transfer-protocol.js";
import { classifyNodeWorkspaceTransferPath } from "../gateway-http-route-contracts.js";
import { sendJson, watchClientDisconnect } from "../http-common.js";
import {
  handleWorkerTransferHttpRequest,
  type ArtifactTransferHttpRequest,
} from "./artifact-transfer-http.js";
import type {
  NodeWorkspaceTransferHttpCallback,
  NodeWorkspaceTransferHttpRoute,
} from "./node-workspace-transfer-http-contract.js";
import type { NodeWorkspaceTransferService } from "./node-workspace-transfer-service.js";
import {
  NodeWorkspaceTransferLimitError,
  nodeWorkspaceTransferInvalidReason,
} from "./node-workspace-upload-reader.js";
import { MAX_WORKSPACE_MANIFEST_BYTES } from "./workspace-inventory-limits.js";

export type { NodeWorkspaceTransferHttpCallback } from "./node-workspace-transfer-http-contract.js";

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const MANIFEST_ENCODINGS = new Set<"gzip">(["gzip"]);
const TRANSFER_TIMEOUT_MS = 10 * 60_000;
const MAX_ENVIRONMENT_ID_LENGTH = 256;
const OPAQUE_NOT_FOUND = { error: "not_found" } as const;

function decodeEnvironmentId(segment: string): string | undefined {
  let value: string;
  try {
    value = decodeURIComponent(segment);
  } catch {
    return undefined;
  }
  if (
    !value ||
    value.length > MAX_ENVIRONMENT_ID_LENGTH ||
    value.includes("/") ||
    value.includes("\\") ||
    value.includes("\0")
  ) {
    return undefined;
  }
  return value;
}

function parseNodeWorkspaceTransferHttpRoute(
  pathname: string,
  method: string | undefined,
): NodeWorkspaceTransferHttpRoute | undefined {
  if (!pathname.startsWith(`${NODE_WORKSPACE_TRANSFER_PATH}/`)) {
    return undefined;
  }
  const segments = pathname.slice(NODE_WORKSPACE_TRANSFER_PATH.length + 1).split("/");
  const [resource, rawEnvironmentId, collection, digest, part] = segments;
  const environmentId = rawEnvironmentId ? decodeEnvironmentId(rawEnvironmentId) : undefined;
  if (!environmentId || resource !== "environments" || !digest || !SHA256_PATTERN.test(digest)) {
    return undefined;
  }
  if (
    method === "GET" &&
    segments.length === 5 &&
    collection === "snapshots" &&
    (part === "manifest" || part === "pack")
  ) {
    return {
      kind: part,
      direction: "download",
      environmentId,
      manifestRef: `sha256:${digest}`,
    };
  }
  if (method === "GET" && segments.length === 4 && collection === "blobs") {
    return { kind: "blob", direction: "download", environmentId, sha256: digest };
  }
  if (method === "POST" && segments.length === 4 && collection === "reconciliations") {
    return {
      kind: "reconcile",
      direction: "upload",
      environmentId,
      baseManifestRef: `sha256:${digest}`,
    };
  }
  return undefined;
}

function sendOpaqueNotFound(res: ServerResponse): void {
  sendJson(res, 404, OPAQUE_NOT_FOUND);
}

/** Reserve and authenticate the node workspace transfer namespace before normal HTTP routing. */
export async function handleNodeWorkspaceTransferHttpRequest(
  params: ArtifactTransferHttpRequest & { callback?: NodeWorkspaceTransferHttpCallback },
): Promise<boolean> {
  const parsed = URL.parse(params.req.url ?? "/", "http://localhost");
  if (!parsed?.pathname || classifyNodeWorkspaceTransferPath(parsed.pathname) === "outside") {
    return false;
  }
  params.res.setHeader("Cache-Control", "no-store");
  const route = parseNodeWorkspaceTransferHttpRoute(parsed.pathname, params.req.method);
  if (!route || parsed.search) {
    sendOpaqueNotFound(params.res);
    return true;
  }
  return handleWorkerTransferHttpRequest(params, (bearer) =>
    params.callback?.({ req: params.req, res: params.res, route, bearer }),
  );
}

export function createNodeWorkspaceTransferHttpCallback(
  service: NodeWorkspaceTransferService,
): NodeWorkspaceTransferHttpCallback {
  return async ({ req, res, route, bearer }) => {
    const authorization = service.authorize({ route, token: bearer });
    if (!authorization) {
      return { kind: "unauthorized" };
    }
    return {
      kind: "authorized",
      handle: async () => {
        const clientAbort = new AbortController();
        const stopWatchingDisconnect = watchClientDisconnect(req, res, clientAbort);
        const signal = AbortSignal.any([
          service.authorizationSignal(authorization),
          clientAbort.signal,
          AbortSignal.timeout(TRANSFER_TIMEOUT_MS),
        ]);
        const abortTransfer = () => {
          // The request can be fully read and destroyed while its uploader still
          // awaits staging validation on the open response.
          if (!res.destroyed) {
            res.destroy(signal.reason instanceof Error ? signal.reason : undefined);
          }
          if (!req.destroyed) {
            req.destroy(signal.reason instanceof Error ? signal.reason : undefined);
          }
        };
        signal.addEventListener("abort", abortTransfer, { once: true });
        if (signal.aborted) {
          abortTransfer();
        }
        const stillCurrent = () => !signal.aborted && service.isAuthorizationCurrent(authorization);
        try {
          if (route.kind === "manifest" || route.kind === "pack") {
            const snapshot = service.snapshot(authorization);
            if (!snapshot) {
              sendOpaqueNotFound(res);
              return;
            }
            if (route.kind === "manifest") {
              let body: Buffer = Buffer.from(snapshot.rawManifest);
              const [encoding] = resolveHttpContentEncodings(
                req.headers["accept-encoding"],
                MANIFEST_ENCODINGS,
              );
              if (encoding === "gzip") {
                body = await pipeline(
                  [body],
                  createGzip({ level: zlibConstants.Z_BEST_SPEED }),
                  async (source) =>
                    await readWorkspaceTransferBody(source, MAX_WORKSPACE_MANIFEST_BYTES),
                  { signal },
                );
              }
              // Token revocation need not abort the context. Revalidate after zlib
              // completes, then queue the complete response without another await.
              if (!stillCurrent()) {
                if (!signal.aborted) {
                  sendOpaqueNotFound(res);
                }
                return;
              }
              res.setHeader("Vary", "Accept-Encoding");
              if (encoding === undefined) {
                res.writeHead(406).end();
                return;
              }
              res.writeHead(200, {
                "content-type": "application/json; charset=utf-8",
                "content-length": String(body.byteLength),
                ...(encoding === "gzip" ? { "content-encoding": "gzip" } : {}),
              });
              res.end(body);
              return;
            }
            const packPath = await service.pack(authorization);
            if (!packPath) {
              sendOpaqueNotFound(res);
              return;
            }
            const stats = await fsp.stat(packPath);
            if (!stillCurrent()) {
              return;
            }
            res.writeHead(200, {
              "content-type": "application/octet-stream",
              "content-length": String(stats.size),
            });
            await pipeline(fs.createReadStream(packPath), res, { signal });
            return;
          }
          if (route.kind === "blob") {
            const blob = service.blob(authorization);
            if (
              !blob ||
              !(await service.verifyBlob({
                path: blob.path,
                size: blob.size,
                sha256: blob.sha256,
              }))
            ) {
              sendOpaqueNotFound(res);
              return;
            }
            if (!stillCurrent()) {
              return;
            }
            res.writeHead(200, {
              "content-type": "application/octet-stream",
              "content-length": String(blob.size),
            });
            await pipeline(fs.createReadStream(blob.path), res, { signal });
            return;
          }
          try {
            const result = await service.receiveUpload({ authorization, request: req, signal });
            if (!stillCurrent()) {
              return;
            }
            const body = Buffer.from(JSON.stringify(result));
            res.writeHead(200, {
              "content-type": "application/json; charset=utf-8",
              "content-length": String(body.byteLength),
            });
            res.end(body);
          } catch (error) {
            if (signal.aborted || res.destroyed) {
              return;
            }
            const limit = error instanceof NodeWorkspaceTransferLimitError;
            const reason = nodeWorkspaceTransferInvalidReason(error);
            const body = Buffer.from(
              JSON.stringify({
                error: limit ? "workspace_transfer_limit" : "workspace_transfer_invalid",
                ...(reason ? { reason } : {}),
              }),
            );
            res.writeHead(limit ? 413 : 400, {
              "content-type": "application/json; charset=utf-8",
              "content-length": String(body.byteLength),
            });
            res.end(body);
          }
        } catch (error) {
          if (!signal.aborted && !res.destroyed) {
            throw error;
          }
        } finally {
          signal.removeEventListener("abort", abortTransfer);
          stopWatchingDisconnect();
        }
      },
    };
  };
}
