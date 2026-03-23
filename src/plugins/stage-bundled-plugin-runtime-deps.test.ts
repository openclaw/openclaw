import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const tempDirs: string[] = [];
const spawnSyncMock = vi.fn();

vi.mock("node:child_process", () => ({
  spawnSync: (...args: unknown[]) => spawnSyncMock(...args),
}));

function makeRepoRoot(prefix: string): string {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(repoRoot);
  return repoRoot;
}

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function loadModule() {
  return await import(`../../scripts/stage-bundled-plugin-runtime-deps.mjs?t=${Date.now()}`);
}

afterEach(() => {
  for (const dir of tempDirs.splice(0, tempDirs.length)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

beforeEach(() => {
  spawnSyncMock.mockReset();
  spawnSyncMock.mockReturnValue({ status: 0, stdout: "", stderr: "" });
});

describe("stageBundledPluginRuntimeDeps", () => {
  it("installs runtime deps for WhatsApp when bundled staging is enabled", async () => {
    const repoRoot = makeRepoRoot("openclaw-whatsapp-runtime-deps-");
    const pluginDir = path.join(repoRoot, "dist", "extensions", "whatsapp");
    fs.mkdirSync(path.join(pluginDir, "node_modules", "stale"), { recursive: true });
    writeJson(path.join(pluginDir, "package.json"), {
      name: "@openclaw/whatsapp",
      dependencies: {
        "@whiskeysockets/baileys": "7.0.0-rc.9",
        jimp: "^1.6.0",
      },
      devDependencies: {
        openclaw: "workspace:*",
      },
      peerDependencies: {
        openclaw: ">=2026.3.22",
      },
      peerDependenciesMeta: {
        openclaw: {
          optional: true,
        },
      },
      openclaw: {
        bundle: {
          stageRuntimeDependencies: true,
        },
      },
    });

    const { stageBundledPluginRuntimeDeps } = await loadModule();
    stageBundledPluginRuntimeDeps({ repoRoot });

    expect(spawnSyncMock).toHaveBeenCalledTimes(1);
    expect(spawnSyncMock).toHaveBeenCalledWith(
      "npm",
      [
        "install",
        "--omit=dev",
        "--silent",
        "--ignore-scripts",
        "--legacy-peer-deps",
        "--package-lock=false",
      ],
      expect.objectContaining({
        cwd: pluginDir,
        encoding: "utf8",
        stdio: "pipe",
        shell: process.platform === "win32",
      }),
    );
    expect(fs.existsSync(path.join(pluginDir, "node_modules"))).toBe(false);

    const bundledManifest = JSON.parse(
      fs.readFileSync(path.join(pluginDir, "package.json"), "utf8"),
    ) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
      peerDependenciesMeta?: Record<string, unknown>;
    };
    expect(bundledManifest.dependencies).toEqual({
      "@whiskeysockets/baileys": "7.0.0-rc.9",
      jimp: "^1.6.0",
    });
    expect(bundledManifest.devDependencies).toBeUndefined();
    expect(bundledManifest.peerDependencies).toBeUndefined();
    expect(bundledManifest.peerDependenciesMeta).toBeUndefined();
  });

  it("skips runtime dep installation when a bundled plugin has no staging opt-in", async () => {
    const repoRoot = makeRepoRoot("openclaw-runtime-deps-no-opt-in-");
    const pluginDir = path.join(repoRoot, "dist", "extensions", "demo");
    fs.mkdirSync(path.join(pluginDir, "node_modules", "stale"), { recursive: true });
    writeJson(path.join(pluginDir, "package.json"), {
      name: "@openclaw/demo",
      dependencies: {
        "left-pad": "1.3.0",
      },
      openclaw: {},
    });

    const { stageBundledPluginRuntimeDeps } = await loadModule();
    stageBundledPluginRuntimeDeps({ repoRoot });

    expect(spawnSyncMock).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(pluginDir, "node_modules"))).toBe(false);
  });
});
