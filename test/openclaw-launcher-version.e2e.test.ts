// Exercises packaged launcher version provenance without loading the runtime.
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { stageLauncherFixture } from "./helpers/openclaw-launcher-fixture.js";
import { useAutoCleanupTempDirTracker } from "./helpers/temp-dir.js";

const roots = useAutoCleanupTempDirTracker(afterEach);
it.each(["checkout", "complete", "fail"] as const)(
  "reports build provenance without loading runtime: %s",
  async (mode) => {
    const fixtureRoot = roots.make("openclaw-launcher-version-");
    const write = (name: string, value: string) =>
      fs.writeFile(path.join(fixtureRoot, name), value);
    await stageLauncherFixture(fixtureRoot);
    await write("package.json", JSON.stringify({ name: "openclaw", version: "1.2.3-test" }));
    await write(
      "dist/entry.js",
      "throw new Error('version fast path must not load the runtime entry');\n",
    );
    if (mode !== "checkout") {
      await write(".openclaw-lifecycle-pending", "pending\n");
      await fs.mkdir(path.join(fixtureRoot, "dist", "infra"), { recursive: true });
      await write(
        "dist/infra/package-lifecycle.js",
        mode === "fail"
          ? 'export async function completePendingPackageLifecycle() { throw new Error("fixture postinstall failed"); }\n'
          : 'import fs from "node:fs/promises"; export async function completePendingPackageLifecycle({ packageRoot }) { await fs.rm(new URL(".openclaw-lifecycle-pending", `file://${packageRoot}/`)); }\n',
      );
    }

    await write(
      "dist/build-info.json",
      JSON.stringify({ version: "2026.8.1", commit: "1234567890abcdef1234567890abcdef12345678" }),
    );
    if (mode === "checkout") {
      await fs.mkdir(path.join(fixtureRoot, ".git"));
      await write(".git/HEAD", "abcdef0123456789abcdef0123456789abcdef01\n");
    }

    const result = spawnSync(
      process.execPath,
      [path.join(fixtureRoot, "openclaw.mjs"), "--version"],
      {
        cwd: fixtureRoot,
        env: {
          ...process.env,
          GIT_COMMIT: undefined,
          GIT_SHA: undefined,
          OPENCLAW_CONTAINER: undefined,
        },
        encoding: "utf8",
      },
    );
    const failed = mode === "fail";
    expect(result).toMatchObject({
      status: failed ? 1 : 0,
      stdout: failed ? "" : "OpenClaw 2026.8.1 (1234567)\n",
    });
    const marker = path.join(fixtureRoot, ".openclaw-lifecycle-pending");
    if (failed) {
      expect(result.stderr).toContain("package lifecycle is incomplete");
      expect(result.stderr).toContain("fixture postinstall failed");
      await expect(fs.readFile(marker, "utf8")).resolves.toBe("pending\n");
    } else if (mode === "complete") {
      await expect(fs.access(marker)).rejects.toHaveProperty("code", "ENOENT");
    } else {
      expect(result.stderr).toBe("");
    }
  },
);
