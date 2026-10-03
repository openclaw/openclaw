// Registry package source for runtimes without npm: manifest and verified archive
// reads through the shared registry document reader.
import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { asRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { buildTimeoutAbortSignal } from "../utils/fetch-timeout.js";
import { cancelUnreadResponseBody } from "./http-body.js";
import { normalizeNpmViewMetadata, type NpmSpecResolution } from "./install-source-utils.js";
import { fetchRegistryPackageDocument } from "./update-check-package-target.js";
import { UPDATE_NETWORK_TIMEOUT_MS } from "./update-network-budget.js";

export async function fetchRegistryPackageManifest(params: {
  registryUrl: string;
  packageName: string;
  version: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<
  { ok: true; metadata: NpmSpecResolution & { tarball: string } } | { ok: false; error: string }
> {
  try {
    const json = await fetchRegistryPackageDocument({
      ...params,
      target: params.version,
      label: "npm package manifest",
      operation: "npm-registry-package-manifest",
      bodyTimeoutMs: Math.max(1, params.timeoutMs ?? UPDATE_NETWORK_TIMEOUT_MS),
    });
    const metadata = normalizeNpmViewMetadata(json, `${params.packageName}@${params.version}`);
    const tarball = normalizeOptionalString(asRecord(asRecord(json).dist).tarball);
    if (!metadata?.name || !metadata.version || !tarball) {
      throw new Error("Registry returned incomplete package metadata (name, version, or tarball).");
    }
    return { ok: true, metadata: { ...metadata, tarball } };
  } catch (error) {
    return { ok: false, error: `Registry package manifest failed: ${String(error)}` };
  }
}

export async function downloadRegistryPackageArchive(params: {
  tarballUrl: string;
  registryUrl: string;
  integrity: string;
  cwd: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<{ ok: true; archivePath: string } | { ok: false; error: string }> {
  const { signal, cleanup, refresh } = buildTimeoutAbortSignal({
    timeoutMs: Math.max(1, params.timeoutMs ?? UPDATE_NETWORK_TIMEOUT_MS),
    signal: params.signal,
    operation: "npm-registry-package-download",
  });
  let response: Response | undefined;
  let archivePath: string | undefined;
  try {
    const url = new URL(params.tarballUrl);
    if (url.origin !== new URL(params.registryUrl).origin) {
      throw new Error("Package tarball must share the registry origin.");
    }
    if (!/^sha512-[A-Za-z0-9+/]{86}==$/u.test(params.integrity)) {
      throw new Error("Package archive requires supported sha512 integrity.");
    }
    // Reject redirects so a same-origin URL cannot send the download elsewhere.
    response = await fetch(url.toString(), { signal, redirect: "error" });
    if (!response.ok || !response.body) {
      throw new Error(`Package archive download failed: HTTP ${response.status}`);
    }
    refresh();
    const hash = createHash("sha512");
    archivePath = path.join(params.cwd, `${randomUUID()}.tgz`);
    await pipeline(
      response.body,
      async function* (chunks) {
        for await (const chunk of chunks) {
          hash.update(chunk);
          refresh();
          yield chunk;
        }
      },
      createWriteStream(archivePath, { flags: "wx", mode: 0o600 }),
      { signal },
    );
    signal?.throwIfAborted();
    if (`sha512-${hash.digest("base64")}` !== params.integrity) {
      throw new Error("Package archive integrity mismatch.");
    }
    return { ok: true, archivePath };
  } catch (error) {
    if (archivePath) {
      await fs.rm(archivePath, { force: true });
    }
    return { ok: false, error: `Registry package archive failed: ${String(error)}` };
  } finally {
    await cancelUnreadResponseBody(response);
    cleanup();
  }
}
