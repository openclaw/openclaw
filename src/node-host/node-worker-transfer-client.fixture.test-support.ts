import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import type { Server, RequestListener, IncomingMessage, ServerResponse } from "node:http";
import type { Server as HttpsServer } from "node:https";
import path from "node:path";
import { buffer } from "node:stream/consumers";
import {
  serializeWorkerWorkspaceManifest as serializeManifest,
  type WorkerWorkspaceManifest,
} from "../gateway/worker-environments/workspace-manifest.js";
import { runNodeWorkerWorkspaceTransfer } from "./node-worker-transfer-client.js";

type TransferOptions = Parameters<typeof runNodeWorkerWorkspaceTransfer>[0];
type TransferOverrides = Omit<
  TransferOptions,
  "gatewayUrl" | "environmentId" | "workspaceDir" | "manifestHome" | "transfer"
>;

export const digest = (body: string | Buffer) => createHash("sha256").update(body).digest("hex");

export function fileEntry(file: string, body: Buffer, mode = 0o644) {
  return { path: file, type: "file" as const, mode, size: body.length, sha256: digest(body) };
}

export function manifestFixture(
  entries: WorkerWorkspaceManifest["entries"] = [],
  options: Partial<Omit<WorkerWorkspaceManifest, "version" | "entries">> = {},
) {
  const rawManifest = serializeManifest({ version: 1, baseCommit: null, ...options, entries });
  return { rawManifest, manifestRef: `sha256:${digest(rawManifest)}` };
}

export async function writeManifest(root: string, raw: string) {
  const hash = digest(raw);
  const manifestDir = path.join(root, ".openclaw-worker", "manifests");
  await fs.mkdir(manifestDir, { recursive: true });
  await fs.writeFile(path.join(manifestDir, `${hash}.json`), raw);
  return hash;
}

export function transferFixture(root: string, environmentId: string) {
  const workspaceDir = path.join(root, "workspace");
  const context = { environmentId, workspaceDir, manifestHome: root };
  const run = (
    gatewayUrl: string,
    transfer: TransferOptions["transfer"],
    overrides: TransferOverrides,
  ) => runNodeWorkerWorkspaceTransfer({ ...context, ...overrides, gatewayUrl, transfer });
  return {
    workspaceDir,
    read: (file: string) => fs.readFile(path.join(workspaceDir, file), "utf8"),
    download: (gatewayUrl: string, manifestRef: string, overrides: TransferOverrides = {}) =>
      run(gatewayUrl, { direction: "download", token: "download-token", manifestRef }, overrides),
    upload: (gatewayUrl: string, manifestRef: string, overrides: TransferOverrides = {}) =>
      run(
        gatewayUrl,
        {
          direction: "upload",
          token: "upload-token",
          baseManifestRef: manifestRef,
          referenceManifestRef: manifestRef,
        },
        overrides,
      ),
  };
}

export function transferHandler(
  handler: (request: IncomingMessage, response: ServerResponse) => Promise<void>,
): RequestListener {
  return (request, response) => {
    void handler(request, response).catch((error: unknown) => {
      response.destroy(error instanceof Error ? error : new Error(String(error)));
    });
  };
}

export async function readUpload(request: IncomingMessage) {
  const body = await buffer(request);
  const currentHeader = 4 + body.readUInt32BE(0);
  const fileHeader = currentHeader + 4 + body.readUInt32BE(currentHeader);
  const currentRaw = body.subarray(currentHeader + 4, fileHeader).toString("utf8");
  return { body, fileHeader, currentRaw, currentRef: `sha256:${digest(currentRaw)}` };
}

export function workspaceTransferHandler(
  rawManifest: string,
  blobs: ReadonlyMap<string, Buffer>,
  currentRef?: () => string | undefined,
  contentLength = false,
) {
  return transferHandler(async (request, response) => {
    const manifest = request.url?.endsWith("/manifest");
    const reconcile =
      !manifest &&
      request.method === "POST" &&
      request.url?.includes("/reconciliations/") &&
      currentRef;
    if (reconcile) {
      for await (const chunk of request) {
        void chunk;
      }
    }
    const body = manifest
      ? rawManifest
      : reconcile
        ? JSON.stringify({ manifestRef: reconcile() })
        : blobs.get(request.url?.match(/\/blobs\/([a-f0-9]{64})$/u)?.[1] ?? "");
    response.writeHead(body === undefined ? 404 : 200, {
      ...(reconcile && contentLength ? { "content-type": "application/json" } : {}),
      ...(contentLength && body !== undefined
        ? { "content-length": String(Buffer.byteLength(body)) }
        : {}),
    });
    response.end(body);
  });
}

export async function closeServer(server: Server | HttpsServer) {
  server.closeAllConnections();
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
}
