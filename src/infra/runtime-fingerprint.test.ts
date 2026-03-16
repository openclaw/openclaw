import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { withEnvAsync } from "../test-utils/env.js";
import { formatRuntimeFingerprint, resolveRuntimeFingerprint } from "./runtime-fingerprint.js";

async function createRepoFixture(params?: { detached?: boolean }) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-runtime-fingerprint-"));
  await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ name: "openclaw" }), "utf8");
  await fs.mkdir(path.join(root, ".git", "refs", "heads"), { recursive: true });
  if (params?.detached) {
    await fs.writeFile(path.join(root, ".git", "HEAD"), "0123456789abcdef\n", "utf8");
  } else {
    await fs.writeFile(
      path.join(root, ".git", "HEAD"),
      "ref: refs/heads/feature/runtime-id\n",
      "utf8",
    );
  }
  return root;
}

const cleanupPaths: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanupPaths.splice(0).map((entry) => fs.rm(entry, { recursive: true, force: true })),
  );
});

describe("runtime-fingerprint", () => {
  it("derives branch, paths, and platform service label from the active worktree", async () => {
    const root = await createRepoFixture();
    cleanupPaths.push(root);

    await withEnvAsync(
      {
        OPENCLAW_PROFILE: "ops",
        OPENCLAW_STATE_DIR: path.join(root, ".state"),
        OPENCLAW_CONFIG_PATH: path.join(root, "config", "openclaw.json"),
      },
      async () => {
        const fingerprint = resolveRuntimeFingerprint({
          cwd: path.join(root, "src"),
          platform: "darwin",
        });

        expect(fingerprint).toEqual({
          branch: "feature/runtime-id",
          worktree: root,
          stateDir: path.join(root, ".state"),
          configPath: path.join(root, "config", "openclaw.json"),
          serviceLabel: "ai.openclaw.ops",
        });
      },
    );
  });

  it("falls back to HEAD for detached checkouts", async () => {
    const root = await createRepoFixture({ detached: true });
    cleanupPaths.push(root);

    const fingerprint = resolveRuntimeFingerprint({
      cwd: root,
      env: {
        OPENCLAW_STATE_DIR: path.join(root, ".state"),
      },
      platform: "linux",
    });

    expect(fingerprint.branch).toBe("HEAD");
    expect(fingerprint.serviceLabel).toBe("openclaw-gateway.service");
  });

  it("formats a stable key=value fingerprint line", () => {
    expect(
      formatRuntimeFingerprint({
        branch: "main",
        worktree: "/repo",
        stateDir: "/state",
        configPath: "/state/openclaw.json",
        serviceLabel: "ai.openclaw.gateway",
      }),
    ).toBe(
      "branch=main worktree=/repo stateDir=/state configPath=/state/openclaw.json serviceLabel=ai.openclaw.gateway",
    );
  });
});
