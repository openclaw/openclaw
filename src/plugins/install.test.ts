import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const tempDirs: string[] = [];

function makeTempDir() {
  const dir = path.join(os.tmpdir(), `clawdbot-plugin-install-${randomUUID()}`);
  fs.mkdirSync(dir, { recursive: true });
  tempDirs.push(dir);
  return dir;
}

function resolveNpmCliJs() {
  const fromEnv = process.env.npm_execpath;
  if (fromEnv?.includes(`${path.sep}npm${path.sep}`) && fromEnv?.endsWith("npm-cli.js")) {
    return fromEnv ?? null;
  }

  const fromNodeDir = path.join(
    path.dirname(process.execPath),
    "node_modules",
    "npm",
    "bin",
    "npm-cli.js",
  );
  if (fs.existsSync(fromNodeDir)) return fromNodeDir;

  const fromLibNodeModules = path.resolve(
    path.dirname(process.execPath),
    "..",
    "lib",
    "node_modules",
    "npm",
    "bin",
    "npm-cli.js",
  );
  if (fs.existsSync(fromLibNodeModules)) return fromLibNodeModules;

  return null;
}

function packToArchive({
  pkgDir,
  outDir,
  outName,
}: {
  pkgDir: string;
  outDir: string;
  outName: string;
}) {
  const npmCli = resolveNpmCliJs();
  const cmd = npmCli ? process.execPath : "npm";
  const args = npmCli
    ? [npmCli, "pack", "--silent", "--pack-destination", outDir, pkgDir]
    : ["pack", "--silent", "--pack-destination", outDir, pkgDir];

  const res = spawnSync(cmd, args, { encoding: "utf-8" });
  expect(res.status).toBe(0);
  if (res.status !== 0) {
    throw new Error(`npm pack failed: ${res.stderr || res.stdout || "<no output>"}`);
  }

  const packed = (res.stdout || "").trim().split(/\r?\n/).filter(Boolean).at(-1);
  if (!packed) {
    throw new Error(`npm pack did not output a filename: ${res.stdout || "<no stdout>"}`);
  }

  const src = path.join(outDir, packed);
  const dest = path.join(outDir, outName);
  fs.rmSync(dest, { force: true });
  fs.renameSync(src, dest);
  return dest;
}

async function withStateDir<T>(stateDir: string, fn: () => Promise<T>) {
  const prev = process.env.CLAWDBOT_STATE_DIR;
  process.env.CLAWDBOT_STATE_DIR = stateDir;
  vi.resetModules();
  try {
    return await fn();
  } finally {
    if (prev === undefined) {
      delete process.env.CLAWDBOT_STATE_DIR;
    } else {
      process.env.CLAWDBOT_STATE_DIR = prev;
    }
    vi.resetModules();
  }
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore cleanup failures
    }
  }
});

describe("installPluginFromArchive", () => {
  it("installs into ~/.clawdbot/extensions and uses unscoped id", async () => {
    const stateDir = makeTempDir();
    const workDir = makeTempDir();
    const pkgDir = path.join(workDir, "package");
    fs.mkdirSync(path.join(pkgDir, "dist"), { recursive: true });
    fs.writeFileSync(
      path.join(pkgDir, "package.json"),
      JSON.stringify({
        name: "@clawdbot/voice-call",
        version: "0.0.1",
        clawdbot: { extensions: ["./dist/index.js"] },
      }),
      "utf-8",
    );
    fs.writeFileSync(path.join(pkgDir, "dist", "index.js"), "export {};", "utf-8");

    const archivePath = packToArchive({
      pkgDir,
      outDir: workDir,
      outName: "plugin.tgz",
    });

    const result = await withStateDir(stateDir, async () => {
      const { installPluginFromArchive } = await import("./install.js");
      return await installPluginFromArchive({ archivePath });
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.pluginId).toBe("voice-call");
    expect(result.targetDir).toBe(path.join(stateDir, "extensions", "voice-call"));
    expect(fs.existsSync(path.join(result.targetDir, "package.json"))).toBe(true);
    expect(fs.existsSync(path.join(result.targetDir, "dist", "index.js"))).toBe(true);
  });

  it("rejects installing when plugin already exists", async () => {
    const stateDir = makeTempDir();
    const workDir = makeTempDir();
    const pkgDir = path.join(workDir, "package");
    fs.mkdirSync(path.join(pkgDir, "dist"), { recursive: true });
    fs.writeFileSync(
      path.join(pkgDir, "package.json"),
      JSON.stringify({
        name: "@clawdbot/voice-call",
        version: "0.0.1",
        clawdbot: { extensions: ["./dist/index.js"] },
      }),
      "utf-8",
    );
    fs.writeFileSync(path.join(pkgDir, "dist", "index.js"), "export {};", "utf-8");

    const archivePath = packToArchive({
      pkgDir,
      outDir: workDir,
      outName: "plugin.tgz",
    });

    const { first, second } = await withStateDir(stateDir, async () => {
      const { installPluginFromArchive } = await import("./install.js");
      const first = await installPluginFromArchive({ archivePath });
      const second = await installPluginFromArchive({ archivePath });
      return { first, second };
    });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.error).toContain("already exists");
  });

  it("allows updates when mode is update", async () => {
    const stateDir = makeTempDir();
    const workDir = makeTempDir();
    const pkgDir = path.join(workDir, "package");
    fs.mkdirSync(path.join(pkgDir, "dist"), { recursive: true });
    fs.writeFileSync(
      path.join(pkgDir, "package.json"),
      JSON.stringify({
        name: "@clawdbot/voice-call",
        version: "0.0.1",
        clawdbot: { extensions: ["./dist/index.js"] },
      }),
      "utf-8",
    );
    fs.writeFileSync(path.join(pkgDir, "dist", "index.js"), "export {};", "utf-8");

    const archiveV1 = packToArchive({
      pkgDir,
      outDir: workDir,
      outName: "plugin-v1.tgz",
    });

    const archiveV2 = (() => {
      fs.writeFileSync(
        path.join(pkgDir, "package.json"),
        JSON.stringify({
          name: "@clawdbot/voice-call",
          version: "0.0.2",
          clawdbot: { extensions: ["./dist/index.js"] },
        }),
        "utf-8",
      );
      return packToArchive({
        pkgDir,
        outDir: workDir,
        outName: "plugin-v2.tgz",
      });
    })();

    const result = await withStateDir(stateDir, async () => {
      const { installPluginFromArchive } = await import("./install.js");
      const first = await installPluginFromArchive({ archivePath: archiveV1 });
      const second = await installPluginFromArchive({ archivePath: archiveV2, mode: "update" });
      return { first, second };
    });

    expect(result.first.ok).toBe(true);
    expect(result.second.ok).toBe(true);
    if (!result.second.ok) return;
    const manifest = JSON.parse(
      fs.readFileSync(path.join(result.second.targetDir, "package.json"), "utf-8"),
    ) as { version?: string };
    expect(manifest.version).toBe("0.0.2");
  });

  it("rejects packages without clawdbot.extensions", async () => {
    const stateDir = makeTempDir();
    const workDir = makeTempDir();
    const pkgDir = path.join(workDir, "package");
    fs.mkdirSync(pkgDir, { recursive: true });
    fs.writeFileSync(
      path.join(pkgDir, "package.json"),
      JSON.stringify({ name: "@clawdbot/nope", version: "0.0.1" }),
      "utf-8",
    );

    const archivePath = packToArchive({
      pkgDir,
      outDir: workDir,
      outName: "bad.tgz",
    });

    const result = await withStateDir(stateDir, async () => {
      const { installPluginFromArchive } = await import("./install.js");
      return await installPluginFromArchive({ archivePath });
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("clawdbot.extensions");
  });
});
