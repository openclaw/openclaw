import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { clearPluginDiscoveryCache, discoverOpenClawPlugins } from "./discovery.js";

const tempDirs: string[] = [];

function makeTempDir() {
  const dir = path.join(os.tmpdir(), `openclaw-plugins-${randomUUID()}`);
  fs.mkdirSync(dir, { recursive: true });
  tempDirs.push(dir);
  return dir;
}

function buildDiscoveryEnv(stateDir: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    OPENCLAW_STATE_DIR: stateDir,
    CLAWDBOT_STATE_DIR: undefined,
    OPENCLAW_BUNDLED_PLUGINS_DIR: "/nonexistent/bundled/plugins",
  };
}

async function discoverWithStateDir(
  stateDir: string,
  params: Parameters<typeof discoverOpenClawPlugins>[0],
) {
  return discoverOpenClawPlugins({ ...params, env: buildDiscoveryEnv(stateDir) });
}

function writePluginPackageManifest(params: {
  packageDir: string;
  packageName: string;
  extensions: string[];
}) {
  fs.writeFileSync(
    path.join(params.packageDir, "package.json"),
    JSON.stringify({
      name: params.packageName,
      openclaw: { extensions: params.extensions },
    }),
    "utf-8",
  );
}

function expectEscapesPackageDiagnostic(diagnostics: Array<{ message: string }>) {
  expect(diagnostics.some((entry) => entry.message.includes("escapes package directory"))).toBe(
    true,
  );
}

afterEach(() => {
  clearPluginDiscoveryCache();
  for (const dir of tempDirs.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore cleanup failures
    }
  }
});

describe("discoverOpenClawPlugins", () => {
  it("discovers global and workspace extensions", async () => {
    const stateDir = makeTempDir();
    const workspaceDir = path.join(stateDir, "workspace");

    const globalExt = path.join(stateDir, "extensions");
    fs.mkdirSync(globalExt, { recursive: true });
    fs.writeFileSync(path.join(globalExt, "alpha.ts"), "export default function () {}", "utf-8");

    const workspaceExt = path.join(workspaceDir, ".openclaw", "extensions");
    fs.mkdirSync(workspaceExt, { recursive: true });
    fs.writeFileSync(path.join(workspaceExt, "beta.ts"), "export default function () {}", "utf-8");

    const { candidates } = await discoverWithStateDir(stateDir, { workspaceDir });

    const ids = candidates.map((c) => c.idHint);
    expect(ids).toContain("alpha");
    expect(ids).toContain("beta");
  });

  it("resolves tilde workspace dirs against the provided env", () => {
    const stateDir = makeTempDir();
    const homeDir = makeTempDir();
    const workspaceRoot = path.join(homeDir, "workspace");
    const workspaceExt = path.join(workspaceRoot, ".openclaw", "extensions");
    fs.mkdirSync(workspaceExt, { recursive: true });
    fs.writeFileSync(path.join(workspaceExt, "tilde-workspace.ts"), "export default {}", "utf-8");

    const result = discoverOpenClawPlugins({
      workspaceDir: "~/workspace",
      env: {
        ...buildDiscoveryEnv(stateDir),
        HOME: homeDir,
      },
    });

    expect(result.candidates.some((candidate) => candidate.idHint === "tilde-workspace")).toBe(
      true,
    );
  });

  it("ignores backup and disabled plugin directories in scanned roots", async () => {
    const stateDir = makeTempDir();
    const globalExt = path.join(stateDir, "extensions");
    fs.mkdirSync(globalExt, { recursive: true });

    const backupDir = path.join(globalExt, "feishu.backup-20260222");
    fs.mkdirSync(backupDir, { recursive: true });
    fs.writeFileSync(path.join(backupDir, "index.ts"), "export default function () {}", "utf-8");

    const disabledDir = path.join(globalExt, "telegram.disabled.20260222");
    fs.mkdirSync(disabledDir, { recursive: true });
    fs.writeFileSync(path.join(disabledDir, "index.ts"), "export default function () {}", "utf-8");

    const bakDir = path.join(globalExt, "discord.bak");
    fs.mkdirSync(bakDir, { recursive: true });
    fs.writeFileSync(path.join(bakDir, "index.ts"), "export default function () {}", "utf-8");

    const liveDir = path.join(globalExt, "live");
    fs.mkdirSync(liveDir, { recursive: true });
    fs.writeFileSync(path.join(liveDir, "index.ts"), "export default function () {}", "utf-8");

    const { candidates } = await discoverWithStateDir(stateDir, {});

    const ids = candidates.map((candidate) => candidate.idHint);
    expect(ids).toContain("live");
    expect(ids).not.toContain("feishu.backup-20260222");
    expect(ids).not.toContain("telegram.disabled.20260222");
    expect(ids).not.toContain("discord.bak");
  });

  it("loads package extension packs", async () => {
    const stateDir = makeTempDir();
    const globalExt = path.join(stateDir, "extensions", "pack");
    fs.mkdirSync(path.join(globalExt, "src"), { recursive: true });

    writePluginPackageManifest({
      packageDir: globalExt,
      packageName: "pack",
      extensions: ["./src/one.ts", "./src/two.ts"],
    });
    fs.writeFileSync(
      path.join(globalExt, "src", "one.ts"),
      "export default function () {}",
      "utf-8",
    );
    fs.writeFileSync(
      path.join(globalExt, "src", "two.ts"),
      "export default function () {}",
      "utf-8",
    );

    const { candidates } = await discoverWithStateDir(stateDir, {});

    const ids = candidates.map((c) => c.idHint);
    expect(ids).toContain("pack/one");
    expect(ids).toContain("pack/two");
  });

  it("derives unscoped ids for scoped packages", async () => {
    const stateDir = makeTempDir();
    const globalExt = path.join(stateDir, "extensions", "voice-call-pack");
    fs.mkdirSync(path.join(globalExt, "src"), { recursive: true });

    writePluginPackageManifest({
      packageDir: globalExt,
      packageName: "@openclaw/voice-call",
      extensions: ["./src/index.ts"],
    });
    fs.writeFileSync(
      path.join(globalExt, "src", "index.ts"),
      "export default function () {}",
      "utf-8",
    );

    const { candidates } = await discoverWithStateDir(stateDir, {});

    const ids = candidates.map((c) => c.idHint);
    expect(ids).toContain("voice-call");
  });

  it("treats configured directory paths as plugin packages", async () => {
    const stateDir = makeTempDir();
    const packDir = path.join(stateDir, "packs", "demo-plugin-dir");
    fs.mkdirSync(packDir, { recursive: true });

    writePluginPackageManifest({
      packageDir: packDir,
      packageName: "@openclaw/demo-plugin-dir",
      extensions: ["./index.js"],
    });
    fs.writeFileSync(path.join(packDir, "index.js"), "module.exports = {}", "utf-8");

    const { candidates } = await discoverWithStateDir(stateDir, { extraPaths: [packDir] });

    const ids = candidates.map((c) => c.idHint);
    expect(ids).toContain("demo-plugin-dir");
  });
  it("blocks extension entries that escape package directory", async () => {
    const stateDir = makeTempDir();
    const globalExt = path.join(stateDir, "extensions", "escape-pack");
    const outside = path.join(stateDir, "outside.js");
    fs.mkdirSync(globalExt, { recursive: true });

    writePluginPackageManifest({
      packageDir: globalExt,
      packageName: "@openclaw/escape-pack",
      extensions: ["../../outside.js"],
    });
    fs.writeFileSync(outside, "export default function () {}", "utf-8");

    const result = await discoverWithStateDir(stateDir, {});

    expect(result.candidates).toHaveLength(0);
    expectEscapesPackageDiagnostic(result.diagnostics);
  });

  it("rejects package extension entries that escape via symlink", async () => {
    const stateDir = makeTempDir();
    const globalExt = path.join(stateDir, "extensions", "pack");
    const outsideDir = path.join(stateDir, "outside");
    const linkedDir = path.join(globalExt, "linked");
    fs.mkdirSync(globalExt, { recursive: true });
    fs.mkdirSync(outsideDir, { recursive: true });
    fs.writeFileSync(path.join(outsideDir, "escape.ts"), "export default {}", "utf-8");
    try {
      fs.symlinkSync(outsideDir, linkedDir, process.platform === "win32" ? "junction" : "dir");
    } catch {
      return;
    }

    writePluginPackageManifest({
      packageDir: globalExt,
      packageName: "@openclaw/pack",
      extensions: ["./linked/escape.ts"],
    });

    const { candidates, diagnostics } = await discoverWithStateDir(stateDir, {});

    expect(candidates.some((candidate) => candidate.idHint === "pack")).toBe(false);
    expectEscapesPackageDiagnostic(diagnostics);
  });

  it("rejects package extension entries that are hardlinked aliases", async () => {
    if (process.platform === "win32") {
      return;
    }
    const stateDir = makeTempDir();
    const globalExt = path.join(stateDir, "extensions", "pack");
    const outsideDir = path.join(stateDir, "outside");
    const outsideFile = path.join(outsideDir, "escape.ts");
    const linkedFile = path.join(globalExt, "escape.ts");
    fs.mkdirSync(globalExt, { recursive: true });
    fs.mkdirSync(outsideDir, { recursive: true });
    fs.writeFileSync(outsideFile, "export default {}", "utf-8");
    try {
      fs.linkSync(outsideFile, linkedFile);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EXDEV") {
        return;
      }
      throw err;
    }

    writePluginPackageManifest({
      packageDir: globalExt,
      packageName: "@openclaw/pack",
      extensions: ["./escape.ts"],
    });

    const { candidates, diagnostics } = await discoverWithStateDir(stateDir, {});

    expect(candidates.some((candidate) => candidate.idHint === "pack")).toBe(false);
    expectEscapesPackageDiagnostic(diagnostics);
  });

  it("ignores package manifests that are hardlinked aliases", async () => {
    if (process.platform === "win32") {
      return;
    }
    const stateDir = makeTempDir();
    const globalExt = path.join(stateDir, "extensions", "pack");
    const outsideDir = path.join(stateDir, "outside");
    const outsideManifest = path.join(outsideDir, "package.json");
    const linkedManifest = path.join(globalExt, "package.json");
    fs.mkdirSync(globalExt, { recursive: true });
    fs.mkdirSync(outsideDir, { recursive: true });
    fs.writeFileSync(path.join(globalExt, "entry.ts"), "export default {}", "utf-8");
    fs.writeFileSync(
      outsideManifest,
      JSON.stringify({
        name: "@openclaw/pack",
        openclaw: { extensions: ["./entry.ts"] },
      }),
      "utf-8",
    );
    try {
      fs.linkSync(outsideManifest, linkedManifest);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EXDEV") {
        return;
      }
      throw err;
    }

    const { candidates } = await discoverWithStateDir(stateDir, {});

    expect(candidates.some((candidate) => candidate.idHint === "pack")).toBe(false);
  });

  it.runIf(process.platform !== "win32")("blocks world-writable plugin paths", async () => {
    const stateDir = makeTempDir();
    const globalExt = path.join(stateDir, "extensions");
    fs.mkdirSync(globalExt, { recursive: true });
    const pluginPath = path.join(globalExt, "world-open.ts");
    fs.writeFileSync(pluginPath, "export default function () {}", "utf-8");
    fs.chmodSync(pluginPath, 0o777);

    const result = await discoverWithStateDir(stateDir, {});

    expect(result.candidates).toHaveLength(0);
    expect(result.diagnostics.some((diag) => diag.message.includes("world-writable path"))).toBe(
      true,
    );
  });

  it.runIf(process.platform !== "win32")(
    "repairs world-writable bundled plugin dirs before loading them",
    async () => {
      const stateDir = makeTempDir();
      const bundledDir = path.join(stateDir, "bundled");
      const packDir = path.join(bundledDir, "demo-pack");
      fs.mkdirSync(packDir, { recursive: true });
      fs.writeFileSync(path.join(packDir, "index.ts"), "export default function () {}", "utf-8");
      fs.chmodSync(packDir, 0o777);

      const result = discoverOpenClawPlugins({
        env: {
          ...process.env,
          OPENCLAW_STATE_DIR: stateDir,
          CLAWDBOT_STATE_DIR: undefined,
          OPENCLAW_BUNDLED_PLUGINS_DIR: bundledDir,
        },
      });

      expect(result.candidates.some((candidate) => candidate.idHint === "demo-pack")).toBe(true);
      expect(
        result.diagnostics.some(
          (diag) => diag.source === packDir && diag.message.includes("world-writable path"),
        ),
      ).toBe(false);
      expect(fs.statSync(packDir).mode & 0o777).toBe(0o755);
    },
  );

  it.runIf(process.platform !== "win32" && typeof process.getuid === "function")(
    "blocks suspicious ownership when uid mismatch is detected",
    async () => {
      const stateDir = makeTempDir();
      const globalExt = path.join(stateDir, "extensions");
      fs.mkdirSync(globalExt, { recursive: true });
      fs.writeFileSync(
        path.join(globalExt, "owner-mismatch.ts"),
        "export default function () {}",
        "utf-8",
      );

      const actualUid = (process as NodeJS.Process & { getuid: () => number }).getuid();
      const result = await discoverWithStateDir(stateDir, { ownershipUid: actualUid + 1 });
      const shouldBlockForMismatch = actualUid !== 0;
      expect(result.candidates).toHaveLength(shouldBlockForMismatch ? 0 : 1);
      expect(result.diagnostics.some((diag) => diag.message.includes("suspicious ownership"))).toBe(
        shouldBlockForMismatch,
      );
    },
  );

  it("reuses discovery results from cache until cleared", async () => {
    const stateDir = makeTempDir();
    const globalExt = path.join(stateDir, "extensions");
    fs.mkdirSync(globalExt, { recursive: true });
    const pluginPath = path.join(globalExt, "cached.ts");
    fs.writeFileSync(pluginPath, "export default function () {}", "utf-8");

    const first = discoverOpenClawPlugins({
      env: {
        ...buildDiscoveryEnv(stateDir),
        OPENCLAW_PLUGIN_DISCOVERY_CACHE_MS: "5000",
      },
    });
    expect(first.candidates.some((candidate) => candidate.idHint === "cached")).toBe(true);

    fs.rmSync(pluginPath, { force: true });

    const second = discoverOpenClawPlugins({
      env: {
        ...buildDiscoveryEnv(stateDir),
        OPENCLAW_PLUGIN_DISCOVERY_CACHE_MS: "5000",
      },
    });
    expect(second.candidates.some((candidate) => candidate.idHint === "cached")).toBe(true);

    clearPluginDiscoveryCache();

    const third = discoverOpenClawPlugins({
      env: {
        ...buildDiscoveryEnv(stateDir),
        OPENCLAW_PLUGIN_DISCOVERY_CACHE_MS: "5000",
      },
    });
    expect(third.candidates.some((candidate) => candidate.idHint === "cached")).toBe(false);
  });

  it("does not reuse discovery results across env root changes", () => {
    const stateDirA = makeTempDir();
    const stateDirB = makeTempDir();
    const globalExtA = path.join(stateDirA, "extensions");
    const globalExtB = path.join(stateDirB, "extensions");
    fs.mkdirSync(globalExtA, { recursive: true });
    fs.mkdirSync(globalExtB, { recursive: true });
    fs.writeFileSync(path.join(globalExtA, "alpha.ts"), "export default function () {}", "utf-8");
    fs.writeFileSync(path.join(globalExtB, "beta.ts"), "export default function () {}", "utf-8");

    const first = discoverOpenClawPlugins({
      env: {
        ...buildDiscoveryEnv(stateDirA),
        OPENCLAW_PLUGIN_DISCOVERY_CACHE_MS: "5000",
      },
    });
    const second = discoverOpenClawPlugins({
      env: {
        ...buildDiscoveryEnv(stateDirB),
        OPENCLAW_PLUGIN_DISCOVERY_CACHE_MS: "5000",
      },
    });

    expect(first.candidates.some((candidate) => candidate.idHint === "alpha")).toBe(true);
    expect(first.candidates.some((candidate) => candidate.idHint === "beta")).toBe(false);
    expect(second.candidates.some((candidate) => candidate.idHint === "alpha")).toBe(false);
    expect(second.candidates.some((candidate) => candidate.idHint === "beta")).toBe(true);
  });

  it("does not reuse extra-path discovery across env home changes", () => {
    const stateDir = makeTempDir();
    const homeA = makeTempDir();
    const homeB = makeTempDir();
    const pluginA = path.join(homeA, "plugins", "demo.ts");
    const pluginB = path.join(homeB, "plugins", "demo.ts");
    fs.mkdirSync(path.dirname(pluginA), { recursive: true });
    fs.mkdirSync(path.dirname(pluginB), { recursive: true });
    fs.writeFileSync(pluginA, "export default {}", "utf-8");
    fs.writeFileSync(pluginB, "export default {}", "utf-8");

    const first = discoverOpenClawPlugins({
      extraPaths: ["~/plugins/demo.ts"],
      env: {
        ...buildDiscoveryEnv(stateDir),
        HOME: homeA,
        OPENCLAW_PLUGIN_DISCOVERY_CACHE_MS: "5000",
      },
    });
    const second = discoverOpenClawPlugins({
      extraPaths: ["~/plugins/demo.ts"],
      env: {
        ...buildDiscoveryEnv(stateDir),
        HOME: homeB,
        OPENCLAW_PLUGIN_DISCOVERY_CACHE_MS: "5000",
      },
    });

    expect(first.candidates.find((candidate) => candidate.idHint === "demo")?.source).toBe(pluginA);
    expect(second.candidates.find((candidate) => candidate.idHint === "demo")?.source).toBe(
      pluginB,
    );
  });

  it("treats configured load-path order as cache-significant", () => {
    const stateDir = makeTempDir();
    const pluginA = path.join(stateDir, "plugins", "alpha.ts");
    const pluginB = path.join(stateDir, "plugins", "beta.ts");
    fs.mkdirSync(path.dirname(pluginA), { recursive: true });
    fs.writeFileSync(pluginA, "export default {}", "utf-8");
    fs.writeFileSync(pluginB, "export default {}", "utf-8");

    const env = {
      ...buildDiscoveryEnv(stateDir),
      OPENCLAW_PLUGIN_DISCOVERY_CACHE_MS: "5000",
    };

    const first = discoverOpenClawPlugins({
      extraPaths: [pluginA, pluginB],
      env,
    });
    const second = discoverOpenClawPlugins({
      extraPaths: [pluginB, pluginA],
      env,
    });

    expect(first.candidates.map((candidate) => candidate.idHint)).toEqual(["alpha", "beta"]);
    expect(second.candidates.map((candidate) => candidate.idHint)).toEqual(["beta", "alpha"]);
  });
});
