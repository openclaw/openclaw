import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { withEnvAsync } from "../test-utils/env.js";
import { discoverOpenClawPlugins } from "./discovery.js";

const tempDirs: string[] = [];

function makeTempDir() {
  const dir = path.join(os.tmpdir(), `openclaw-plugins-${randomUUID()}`);
  fs.mkdirSync(dir, { recursive: true });
  tempDirs.push(dir);
  return dir;
}

async function withStateDir<T>(stateDir: string, fn: () => Promise<T>) {
  return await withEnvAsync(
    {
      OPENCLAW_STATE_DIR: stateDir,
      CLAWDBOT_STATE_DIR: undefined,
      OPENCLAW_BUNDLED_PLUGINS_DIR: "/nonexistent/bundled/plugins",
    },
    fn,
  );
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

    const { candidates } = await withStateDir(stateDir, async () => {
      return discoverOpenClawPlugins({ workspaceDir });
    });

    const ids = candidates.map((c) => c.idHint);
    expect(ids).toContain("alpha");
    expect(ids).toContain("beta");
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

    const { candidates } = await withStateDir(stateDir, async () => {
      return discoverOpenClawPlugins({});
    });

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

    fs.writeFileSync(
      path.join(globalExt, "package.json"),
      JSON.stringify({
        name: "pack",
        openclaw: { extensions: ["./src/one.ts", "./src/two.ts"] },
      }),
      "utf-8",
    );
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

    const { candidates } = await withStateDir(stateDir, async () => {
      return discoverOpenClawPlugins({});
    });

    const ids = candidates.map((c) => c.idHint);
    expect(ids).toContain("pack/one");
    expect(ids).toContain("pack/two");
  });

  it("derives unscoped ids for scoped packages", async () => {
    const stateDir = makeTempDir();
    const globalExt = path.join(stateDir, "extensions", "voice-call-pack");
    fs.mkdirSync(path.join(globalExt, "src"), { recursive: true });

    fs.writeFileSync(
      path.join(globalExt, "package.json"),
      JSON.stringify({
        name: "@openclaw/voice-call",
        openclaw: { extensions: ["./src/index.ts"] },
      }),
      "utf-8",
    );
    fs.writeFileSync(
      path.join(globalExt, "src", "index.ts"),
      "export default function () {}",
      "utf-8",
    );

    const { candidates } = await withStateDir(stateDir, async () => {
      return discoverOpenClawPlugins({});
    });

    const ids = candidates.map((c) => c.idHint);
    expect(ids).toContain("voice-call");
  });

  it("treats configured directory paths as plugin packages", async () => {
    const stateDir = makeTempDir();
    const packDir = path.join(stateDir, "packs", "demo-plugin-dir");
    fs.mkdirSync(packDir, { recursive: true });

    fs.writeFileSync(
      path.join(packDir, "package.json"),
      JSON.stringify({
        name: "@openclaw/demo-plugin-dir",
        openclaw: { extensions: ["./index.js"] },
      }),
      "utf-8",
    );
    fs.writeFileSync(path.join(packDir, "index.js"), "module.exports = {}", "utf-8");

    const { candidates } = await withStateDir(stateDir, async () => {
      return discoverOpenClawPlugins({ extraPaths: [packDir] });
    });

    const ids = candidates.map((c) => c.idHint);
    expect(ids).toContain("demo-plugin-dir");
  });
  it("blocks extension entries that escape package directory", async () => {
    const stateDir = makeTempDir();
    const globalExt = path.join(stateDir, "extensions", "escape-pack");
    const outside = path.join(stateDir, "outside.js");
    fs.mkdirSync(globalExt, { recursive: true });

    fs.writeFileSync(
      path.join(globalExt, "package.json"),
      JSON.stringify({
        name: "@openclaw/escape-pack",
        openclaw: { extensions: ["../../outside.js"] },
      }),
      "utf-8",
    );
    fs.writeFileSync(outside, "export default function () {}", "utf-8");

    const result = await withStateDir(stateDir, async () => {
      return discoverOpenClawPlugins({});
    });

    expect(result.candidates).toHaveLength(0);
    expect(
      result.diagnostics.some((diag) => diag.message.includes("escapes package directory")),
    ).toBe(true);
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

    fs.writeFileSync(
      path.join(globalExt, "package.json"),
      JSON.stringify({
        name: "@openclaw/pack",
        openclaw: { extensions: ["./linked/escape.ts"] },
      }),
      "utf-8",
    );

    const { candidates, diagnostics } = await withStateDir(stateDir, async () => {
      return discoverOpenClawPlugins({});
    });

    expect(candidates.some((candidate) => candidate.idHint === "pack")).toBe(false);
    expect(diagnostics.some((entry) => entry.message.includes("escapes package directory"))).toBe(
      true,
    );
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

    fs.writeFileSync(
      path.join(globalExt, "package.json"),
      JSON.stringify({
        name: "@openclaw/pack",
        openclaw: { extensions: ["./escape.ts"] },
      }),
      "utf-8",
    );

    const { candidates, diagnostics } = await withStateDir(stateDir, async () => {
      return discoverOpenClawPlugins({});
    });

    expect(candidates.some((candidate) => candidate.idHint === "pack")).toBe(false);
    expect(diagnostics.some((entry) => entry.message.includes("escapes package directory"))).toBe(
      true,
    );
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

    const { candidates } = await withStateDir(stateDir, async () => {
      return discoverOpenClawPlugins({});
    });

    expect(candidates.some((candidate) => candidate.idHint === "pack")).toBe(false);
  });

  it.runIf(process.platform !== "win32")("blocks world-writable plugin paths", async () => {
    const stateDir = makeTempDir();
    const globalExt = path.join(stateDir, "extensions");
    fs.mkdirSync(globalExt, { recursive: true });
    const pluginPath = path.join(globalExt, "world-open.ts");
    fs.writeFileSync(pluginPath, "export default function () {}", "utf-8");
    fs.chmodSync(pluginPath, 0o777);

    const result = await withStateDir(stateDir, async () => {
      return discoverOpenClawPlugins({});
    });

    expect(result.candidates).toHaveLength(0);
    expect(result.diagnostics.some((diag) => diag.message.includes("world-writable path"))).toBe(
      true,
    );
  });

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
      const result = await withStateDir(stateDir, async () => {
        return discoverOpenClawPlugins({ ownershipUid: actualUid + 1 });
      });
      expect(result.candidates).toHaveLength(0);
      expect(result.diagnostics.some((diag) => diag.message.includes("suspicious ownership"))).toBe(
        true,
      );
    },
  );
});
