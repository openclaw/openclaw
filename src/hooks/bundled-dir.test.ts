import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { captureEnv } from "../test-utils/env.js";
import { resolveBundledHooksDir } from "./bundled-dir.js";

async function writeBundledHook(params: { hooksDir: string; name: string }): Promise<void> {
  const hookDir = path.join(params.hooksDir, params.name);
  await fs.mkdir(hookDir, { recursive: true });
  await fs.writeFile(path.join(hookDir, "HOOK.md"), `---\nname: ${params.name}\n---\n`, "utf-8");
  await fs.writeFile(
    path.join(hookDir, "handler.js"),
    "export default async function() {}\n",
    "utf-8",
  );
}

describe("resolveBundledHooksDir", () => {
  let envSnapshot: ReturnType<typeof captureEnv>;

  beforeEach(() => {
    envSnapshot = captureEnv(["OPENCLAW_BUNDLED_HOOKS_DIR"]);
  });

  afterEach(() => {
    envSnapshot.restore();
  });

  it("returns OPENCLAW_BUNDLED_HOOKS_DIR override when set", async () => {
    const overrideDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "openclaw-bundled-hooks-override-"),
    );
    process.env.OPENCLAW_BUNDLED_HOOKS_DIR = ` ${overrideDir} `;
    expect(resolveBundledHooksDir()).toBe(overrideDir);
  });

  it("resolves bundled hooks under a flattened dist layout", async () => {
    delete process.env.OPENCLAW_BUNDLED_HOOKS_DIR;

    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-bundled-hooks-"));
    await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ name: "openclaw" }));

    const distBundled = path.join(root, "dist", "bundled");
    await writeBundledHook({ hooksDir: distBundled, name: "session-memory" });

    const distDir = path.join(root, "dist");
    await fs.mkdir(distDir, { recursive: true });
    const argv1 = path.join(distDir, "entry.js");
    await fs.writeFile(argv1, "// stub", "utf-8");

    const moduleUrl = pathToFileURL(path.join(distDir, "workspace.js")).href;
    const execPath = path.join(root, "bin", "node");
    await fs.mkdir(path.dirname(execPath), { recursive: true });

    const resolved = resolveBundledHooksDir({
      argv1,
      moduleUrl,
      cwd: distDir,
      execPath,
    });

    expect(resolved).toBe(distBundled);
  });

  it("skips non-hook exec sibling dirs and falls back to package dist hooks", async () => {
    delete process.env.OPENCLAW_BUNDLED_HOOKS_DIR;

    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-bundled-hooks-fallback-"));
    await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ name: "openclaw" }));

    const execPath = path.join(root, "runtime", "node");
    const execSiblingHooks = path.join(path.dirname(execPath), "hooks", "bundled");
    await fs.mkdir(execSiblingHooks, { recursive: true });

    const distBundled = path.join(root, "dist", "bundled");
    await writeBundledHook({ hooksDir: distBundled, name: "command-logger" });

    const distDir = path.join(root, "dist");
    await fs.mkdir(distDir, { recursive: true });
    const argv1 = path.join(distDir, "entry.js");
    await fs.writeFile(argv1, "// stub", "utf-8");
    const moduleUrl = pathToFileURL(path.join(distDir, "workspace.js")).href;

    const resolved = resolveBundledHooksDir({
      argv1,
      moduleUrl,
      cwd: distDir,
      execPath,
    });

    expect(resolved).toBe(distBundled);
  });
});
