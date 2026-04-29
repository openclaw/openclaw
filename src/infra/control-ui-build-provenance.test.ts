import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
  resolveCachedControlUiBuildProvenance,
  resolveControlUiBuildProvenance,
} from "./control-ui-build-provenance.js";

async function withPackageRoot<T>(fn: (root: string) => Promise<T>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-provenance-"));
  try {
    await fs.mkdir(path.join(root, "dist", "infra"), { recursive: true });
    await fs.writeFile(
      path.join(root, "package.json"),
      JSON.stringify({
        name: "openclaw",
        version: "2099.1.2",
        repository: { url: "git+https://github.com/openclaw/openclaw.git" },
      }),
    );
    await fs.writeFile(path.join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    return await fn(root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

describe("resolveControlUiBuildProvenance", () => {
  it("reads package metadata and lockfile from the resolved package root", async () => {
    await withPackageRoot(async (root) => {
      const lockfile = await fs.readFile(path.join(root, "pnpm-lock.yaml"));
      const moduleUrl = pathToFileURL(
        path.join(root, "dist", "infra", "control-ui-build-provenance.js"),
      ).href;

      expect(
        resolveControlUiBuildProvenance({
          cwd: root,
          moduleUrl,
          argv1: path.join(root, "openclaw.mjs"),
          env: {
            GITHUB_SHA: "ABCDEF0123456789",
            GITHUB_RUN_ID: "12345",
            SOURCE_DATE_EPOCH: "1772323200",
          },
        }),
      ).toEqual({
        sourceRepositoryUrl: "git+https://github.com/openclaw/openclaw.git",
        commitSha: "abcdef0123456789",
        buildTimestamp: "2026-03-01T00:00:00.000Z",
        packageVersion: "2099.1.2",
        lockfileSha256: crypto.createHash("sha256").update(lockfile).digest("hex"),
        ciRunId: "12345",
      });
    });
  });

  it("caches default process provenance by module URL", () => {
    const first = resolveCachedControlUiBuildProvenance({ moduleUrl: import.meta.url });
    const second = resolveCachedControlUiBuildProvenance({ moduleUrl: import.meta.url });

    expect(second).toBe(first);
  });
});
