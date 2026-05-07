import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runPluginPayloadSmokeCheck } from "./plugin-payload-validation.js";

describe("runPluginPayloadSmokeCheck", () => {
  let tmpRoot: string;
  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-payload-smoke-"));
  });
  afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  async function writePackage(
    dir: string,
    manifest: Record<string, unknown>,
    mainContent?: string,
  ) {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "package.json"), JSON.stringify(manifest), "utf8");
    const main = typeof manifest.main === "string" ? manifest.main : "index.js";
    if (mainContent !== undefined) {
      const target = path.join(dir, main);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, mainContent, "utf8");
    }
  }

  it("reports ok for a record whose package.json + main file exist", async () => {
    const dir = path.join(tmpRoot, "discord");
    await writePackage(
      dir,
      { name: "@openclaw/discord", main: "dist/index.js" },
      "module.exports = {};",
    );
    const result = await runPluginPayloadSmokeCheck({
      records: { discord: { source: "npm", installPath: dir } },
      env: {},
    });
    expect(result.failures).toEqual([]);
    expect(result.checked).toEqual(["discord"]);
  });

  it("reports a failure when the package directory is missing", async () => {
    const dir = path.join(tmpRoot, "brave");
    const result = await runPluginPayloadSmokeCheck({
      records: { brave: { source: "npm", installPath: dir } },
      env: {},
    });
    expect(result.failures).toEqual([
      {
        pluginId: "brave",
        installPath: dir,
        reason: "missing-package-dir",
        detail: expect.stringContaining(dir),
      },
    ]);
  });

  it("reports a failure when the package.json is missing", async () => {
    const dir = path.join(tmpRoot, "brave");
    await fs.mkdir(dir, { recursive: true });
    const result = await runPluginPayloadSmokeCheck({
      records: { brave: { source: "npm", installPath: dir } },
      env: {},
    });
    expect(result.failures).toEqual([
      {
        pluginId: "brave",
        installPath: dir,
        reason: "missing-package-json",
        detail: expect.stringContaining("package.json"),
      },
    ]);
  });

  it("reports a failure when the main entry file is missing on disk", async () => {
    const dir = path.join(tmpRoot, "brave");
    await writePackage(dir, { name: "@openclaw/brave", main: "dist/index.js" });
    const result = await runPluginPayloadSmokeCheck({
      records: { brave: { source: "npm", installPath: dir } },
      env: {},
    });
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toMatchObject({
      pluginId: "brave",
      reason: "missing-main-entry",
    });
    expect(result.failures[0]?.detail).toContain("dist/index.js");
  });

  it("falls back to package root index.js when main is absent", async () => {
    const dir = path.join(tmpRoot, "matrix");
    await writePackage(dir, { name: "@openclaw/plugin-matrix" }, "module.exports = {};");
    const result = await runPluginPayloadSmokeCheck({
      records: { matrix: { source: "npm", installPath: dir } },
      env: {},
    });
    expect(result.failures).toEqual([]);
  });

  it("reports a failure when package.json cannot be parsed", async () => {
    const dir = path.join(tmpRoot, "broken");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "package.json"), "not-json", "utf8");
    const result = await runPluginPayloadSmokeCheck({
      records: { broken: { source: "npm", installPath: dir } },
      env: {},
    });
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toMatchObject({
      pluginId: "broken",
      reason: "invalid-package-json",
    });
  });

  it("skips records without an installPath (handled by upstream payload check)", async () => {
    const result = await runPluginPayloadSmokeCheck({
      records: {
        discord: { source: "npm" } as unknown as { source: "npm"; installPath?: string },
      },
      env: {},
    });
    expect(result.checked).toEqual([]);
    expect(result.failures).toEqual([]);
  });

  it("only checks records whose source is package-tracked (npm/clawhub/git/marketplace)", async () => {
    const dir = path.join(tmpRoot, "tracked");
    await writePackage(dir, { name: "tracked" }, "module.exports = {};");
    const records = {
      bundled: { source: "bundled", installPath: dir } as never,
      npm: { source: "npm" as const, installPath: dir },
    };
    const result = await runPluginPayloadSmokeCheck({
      records,
      env: {},
    });
    expect(result.checked).toEqual(["npm"]);
  });
});
