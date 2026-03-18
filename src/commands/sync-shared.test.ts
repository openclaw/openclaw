import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runLocalTruthSync } from "./sync-shared.js";

async function withTempDir<T>(prefix: string, run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  try {
    return await run(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function writeFile(filePath: string, contents: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, contents, "utf8");
}

describe("runLocalTruthSync", () => {
  afterEach(() => {
    delete process.env.OPENCLAW_STATE_DIR;
    delete process.env.OPENCLAW_CONFIG_PATH;
    delete process.env.OPENCLAW_OPERATOR_DEB_URL;
    delete process.env.OPENCLAW_OPERATOR_DEB_SHARED_SECRET;
    delete process.env.OPENCLAW_OPERATOR_CONTROL_PLANE_URL;
    delete process.env.OPENCLAW_OPERATOR_CONTROL_PLANE_SHARED_SECRET;
  });

  it("plans add/update work, preserves remote-only files, and skips excluded repo paths", async () => {
    await withTempDir("openclaw-sync-source-", async (sourceRoot) => {
      const repoSource = path.join(sourceRoot, "openclaw");
      const stateDir = path.join(sourceRoot, ".openclaw");
      const workspaceDir = path.join(stateDir, "workspace");
      const credentialsDir = path.join(stateDir, "credentials");
      const agentStateDir = path.join(stateDir, "agents", "main", "agent");
      const targetHome = path.join(sourceRoot, "target-home");

      process.env.OPENCLAW_STATE_DIR = stateDir;
      process.env.OPENCLAW_CONFIG_PATH = path.join(stateDir, "openclaw.json");
      process.env.OPENCLAW_OPERATOR_DEB_URL = "http://deb.internal:3010";
      process.env.OPENCLAW_OPERATOR_DEB_SHARED_SECRET = "deb-secret";

      await writeFile(path.join(repoSource, "README.md"), "# repo\n");
      await writeFile(path.join(repoSource, ".git", "HEAD"), "ref: refs/heads/main\n");
      await writeFile(path.join(repoSource, "node_modules", "pkg", "index.js"), "skip\n");
      await writeFile(path.join(credentialsDir, "oauth.json"), '{"token":true}\n');
      await writeFile(path.join(agentStateDir, "auth-profiles.json"), '{"profiles":{}}\n');
      await writeFile(path.join(workspaceDir, "MEMORY.md"), "workspace memory\n");
      await writeFile(
        path.join(stateDir, "openclaw.json"),
        JSON.stringify({
          agents: {
            defaults: {},
          },
        }),
      );

      await writeFile(path.join(targetHome, "openclaw", "README.md"), "# old repo\n");
      await writeFile(path.join(targetHome, "openclaw", "remote-only.txt"), "keep me\n");
      await writeFile(path.join(targetHome, "agents", ".env"), "EXISTING_KEY=1\n");
      await writeFile(
        path.join(targetHome, "agents", "openclaw.json"),
        JSON.stringify({
          gateway: { mode: "local" },
        }),
      );

      const plan = await runLocalTruthSync({
        targetHome,
        repoSource,
      });

      expect(plan.mirror.operations.some((entry) => entry.targetPath.endsWith(".git/HEAD"))).toBe(
        false,
      );
      expect(
        plan.mirror.operations.some((entry) => entry.targetPath.includes("node_modules")),
      ).toBe(false);
      expect(plan.mirror.counts.update).toBeGreaterThanOrEqual(1);
      expect(plan.mirror.remoteOnly).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            targetPath: path.join(targetHome, "openclaw", "remote-only.txt"),
          }),
        ]),
      );

      const applied = await runLocalTruthSync({
        targetHome,
        repoSource,
        apply: true,
      });

      expect(await fs.readFile(path.join(targetHome, "openclaw", "README.md"), "utf8")).toBe(
        "# repo\n",
      );
      expect(await fs.readFile(path.join(targetHome, "openclaw", "remote-only.txt"), "utf8")).toBe(
        "keep me\n",
      );
      expect(
        await fs.readFile(path.join(targetHome, "agents", "workspace", "MEMORY.md"), "utf8"),
      ).toBe("workspace memory\n");
      expect(await fs.readFile(path.join(targetHome, "agents", ".env"), "utf8")).toContain(
        "OPENCLAW_STATE_DIR=~/agents",
      );
      expect(await fs.readFile(path.join(targetHome, "agents", "openclaw.json"), "utf8")).toContain(
        '"workspace": "~/agents/workspace"',
      );
      expect(applied.applied).toBe(true);
    });
  });

  it("supports settings-only apply without mirroring files", async () => {
    await withTempDir("openclaw-sync-settings-", async (root) => {
      const stateDir = path.join(root, ".openclaw");
      const targetHome = path.join(root, "target-home");
      process.env.OPENCLAW_STATE_DIR = stateDir;
      process.env.OPENCLAW_CONFIG_PATH = path.join(stateDir, "openclaw.json");
      process.env.OPENCLAW_OPERATOR_CONTROL_PLANE_URL = "http://tonya.internal:18789";
      await writeFile(
        path.join(stateDir, "openclaw.json"),
        JSON.stringify({
          agents: {
            defaults: {},
          },
        }),
      );
      await writeFile(path.join(targetHome, "openclaw", "README.md"), "old\n");
      await writeFile(path.join(targetHome, "agents", "openclaw.json"), JSON.stringify({}));

      const result = await runLocalTruthSync({
        targetHome,
        settingsOnly: true,
        apply: true,
      });

      await expect(
        fs.access(path.join(targetHome, "openclaw", "README.md")),
      ).resolves.toBeUndefined();
      expect(result.mirror.operations).toHaveLength(0);
      expect(await fs.readFile(path.join(targetHome, "agents", ".env"), "utf8")).toContain(
        "OPENCLAW_STATE_DIR=~/agents",
      );
      expect(await fs.readFile(path.join(targetHome, "agents", "openclaw.json"), "utf8")).toContain(
        '"workspace": "~/agents/workspace"',
      );
    });
  });
});
