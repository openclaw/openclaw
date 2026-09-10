import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCommandWithTimeout } from "../../process/exec.js";
import {
  MAX_RECONCILIATION_FILE_BYTES,
  serializeWorkerWorkspaceManifest,
  type WorkerWorkspaceManifest,
  type WorkerWorkspaceManifestEntry,
} from "./workspace-manifest.js";
import * as workspaceReconcileFs from "./workspace-reconcile-fs.js";
import {
  workerWorkspaceResultRef,
  workerWorkspaceResultStaging,
} from "./workspace-result-staging.js";

const { stageWorkerWorkspaceResult } = workerWorkspaceResultStaging;
const roots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function temporaryDirectory(name: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `openclaw-${name}-`));
  roots.push(root);
  return root;
}

async function gitInit(root: string): Promise<void> {
  const result = await runCommandWithTimeout(["git", "-C", root, "init", "--quiet"], {
    timeoutMs: 10_000,
  });
  expect(result.code).toBe(0);
}

async function manifestFor(root: string): Promise<WorkerWorkspaceManifest> {
  const entries: WorkerWorkspaceManifestEntry[] = [];
  for (const name of (await fs.readdir(root)).toSorted()) {
    if (name === ".git") {
      continue;
    }
    const absolute = path.join(root, name);
    const content = await fs.readFile(absolute);
    entries.push({
      path: name,
      type: "file",
      mode: 0o644,
      size: content.length,
      sha256: createHash("sha256").update(content).digest("hex"),
    });
  }
  return { version: 1, baseCommit: null, entries, directories: [] };
}

function encodeWorkspaceManifest(manifest: WorkerWorkspaceManifest) {
  const raw = serializeWorkerWorkspaceManifest(manifest);
  return { raw, ref: `sha256:${createHash("sha256").update(raw).digest("hex")}` };
}

describe("worker workspace result staging cap", () => {
  it("rejects a file that grows past the reconciliation cap after the hash match", async () => {
    const local = await temporaryDirectory("workspace-staged-oversize-reread-local");
    const payload = await temporaryDirectory("workspace-staged-oversize-reread-payload");
    await gitInit(local);
    await fs.writeFile(path.join(payload, "result.txt"), "worker\n");
    const base = encodeWorkspaceManifest(await manifestFor(local));
    const current = encodeWorkspaceManifest(await manifestFor(payload));
    vi.spyOn(workspaceReconcileFs, "absoluteEntryMatches").mockImplementation(async (absolute) => {
      await fs.truncate(absolute, MAX_RECONCILIATION_FILE_BYTES + 1);
      return true;
    });

    await expect(
      stageWorkerWorkspaceResult({
        root: local,
        stagingRoot: payload,
        stagedResultRef: workerWorkspaceResultRef("claim-oversize-reread"),
        baseManifestRef: base.ref,
        currentManifestRef: current.ref,
        baseManifestRaw: base.raw,
        currentManifestRaw: current.raw,
      }),
    ).rejects.toThrow("exceeds its byte limit");
  });
});
