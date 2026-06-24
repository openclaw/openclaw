// Covers config IO permission-denied errors and recovery messaging.
import fsNode from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createConfigIO } from "./io.js";
import type { OpenClawConfig } from "./types.openclaw.js";

function makeEaccesFs(configPath: string) {
  const eaccesErr = Object.assign(new Error(`EACCES: permission denied, open '${configPath}'`), {
    code: "EACCES",
  });
  return {
    existsSync: (p: string) => p === configPath,
    readFileSync: (p: string): string => {
      if (p === configPath) {
        throw eaccesErr;
      }
      throw new Error(`unexpected readFileSync: ${p}`);
    },
    promises: {
      readFile: () => Promise.reject(eaccesErr),
      mkdir: () => Promise.resolve(),
      writeFile: () => Promise.resolve(),
      appendFile: () => Promise.resolve(),
    },
  } as unknown as typeof import("node:fs");
}

describe("config io EACCES handling", () => {
  it("returns a helpful error message when config file is not readable (EACCES)", async () => {
    const configPath = "/data/.openclaw/openclaw.json";
    const errors: string[] = [];
    const io = createConfigIO({
      configPath,
      fs: makeEaccesFs(configPath),
      logger: {
        error: (msg: unknown) => errors.push(String(msg)),
        warn: () => {},
      },
    });

    const snapshot = await io.readConfigFileSnapshot();
    expect(snapshot.valid).toBe(false);
    expect(snapshot.issues).toHaveLength(1);
    expect(snapshot.issues[0].message).toContain("EACCES");
    expect(snapshot.issues[0].message).toContain("chown");
    expect(snapshot.issues[0].message).toContain(configPath);
    // Should also emit to the logger
    expect(errors.join("\n")).toContain("chown");
  });

  it("includes configPath in the chown hint for the correct remediation command", async () => {
    const configPath = "/home/myuser/.openclaw/openclaw.json";
    const io = createConfigIO({
      configPath,
      fs: makeEaccesFs(configPath),
      logger: { error: () => {}, warn: () => {} },
    });

    const snapshot = await io.readConfigFileSnapshot();
    expect(snapshot.issues[0].message).toContain(configPath);
    expect(snapshot.issues[0].message).toContain("container");
  });

  it("marks the snapshot with the underlying read error code", async () => {
    const configPath = "/data/.openclaw/openclaw.json";
    const io = createConfigIO({
      configPath,
      fs: makeEaccesFs(configPath),
      logger: { error: () => {}, warn: () => {} },
    });

    const snapshot = await io.readConfigFileSnapshot();
    expect(snapshot.readError).toEqual({ code: "EACCES" });
  });
});

function makeUnreadableConfigFs(configPath: string): typeof fsNode {
  const eacces = Object.assign(new Error(`EACCES: permission denied, open '${configPath}'`), {
    code: "EACCES",
  });
  const readFileSync = ((target: fsNode.PathOrFileDescriptor, options?: unknown) => {
    if (target === configPath) {
      throw eacces;
    }
    return fsNode.readFileSync(target, options as never);
  }) as typeof fsNode.readFileSync;
  const readFile = ((target: unknown, options?: unknown) => {
    if (target === configPath) {
      return Promise.reject(eacces);
    }
    return fsNode.promises.readFile(target as never, options as never);
  }) as typeof fsNode.promises.readFile;
  return {
    ...fsNode,
    readFileSync,
    promises: { ...fsNode.promises, readFile },
  } as typeof fsNode;
}

describe("config write guard after unreadable config", () => {
  const tempRoots: string[] = [];
  afterEach(() => {
    while (tempRoots.length > 0) {
      const root = tempRoots.pop();
      if (root) {
        fsNode.rmSync(root, { recursive: true, force: true });
      }
    }
  });

  it("refuses to overwrite a present-but-unreadable config and preserves the live file", async () => {
    const home = fsNode.mkdtempSync(path.join(os.tmpdir(), "openclaw-unreadable-"));
    tempRoots.push(home);
    const stateDir = path.join(home, ".openclaw");
    fsNode.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    const configPath = path.join(stateDir, "openclaw.json");
    const liveConfig = {
      gateway: { mode: "local", port: 18789, auth: { mode: "token" } },
      channels: { telegram: { enabled: true } },
      agents: { list: [{ id: "main" }] },
      meta: { lastTouchedVersion: "2026.5.3-1" },
    };
    const liveBytes = `${JSON.stringify(liveConfig, null, 2)}\n`;
    fsNode.writeFileSync(configPath, liveBytes, { mode: 0o600 });

    const io = createConfigIO({
      configPath,
      fs: makeUnreadableConfigFs(configPath),
      homedir: () => home,
      env: {},
      observe: false,
      logger: { error: () => {}, warn: () => {} },
    });

    const snapshot = await io.readConfigFileSnapshot();
    expect(snapshot.readError).toEqual({ code: "EACCES" });

    const skeletal = { channels: { telegram: { enabled: true } } } as OpenClawConfig;
    let rejected: { code?: string; reasons?: string[] } | null = null;
    try {
      await io.writeConfigFile(skeletal);
    } catch (err) {
      rejected = err as { code?: string; reasons?: string[] };
    }

    expect(rejected?.code).toBe("CONFIG_WRITE_REJECTED");
    expect(rejected?.reasons).toContain("unreadable-config-before-write");
    expect(fsNode.readFileSync(configPath, "utf-8")).toBe(liveBytes);
    const rejectedArtifacts = fsNode
      .readdirSync(stateDir)
      .filter((name) => name.startsWith("openclaw.json.rejected."));
    expect(rejectedArtifacts).toHaveLength(1);
  });

  it("rejects even when the update doctor pass allows a size drop", async () => {
    const home = fsNode.mkdtempSync(path.join(os.tmpdir(), "openclaw-unreadable-"));
    tempRoots.push(home);
    const stateDir = path.join(home, ".openclaw");
    fsNode.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    const configPath = path.join(stateDir, "openclaw.json");
    const liveBytes = `${JSON.stringify(
      { gateway: { mode: "local", port: 18789 }, meta: { lastTouchedVersion: "2026.5.3-1" } },
      null,
      2,
    )}\n`;
    fsNode.writeFileSync(configPath, liveBytes, { mode: 0o600 });

    const io = createConfigIO({
      configPath,
      fs: makeUnreadableConfigFs(configPath),
      homedir: () => home,
      env: {},
      observe: false,
      logger: { error: () => {}, warn: () => {} },
    });

    const skeletal = { channels: { telegram: { enabled: true } } } as OpenClawConfig;
    let rejected: { code?: string; reasons?: string[] } | null = null;
    try {
      await io.writeConfigFile(skeletal, { allowConfigSizeDrop: true });
    } catch (err) {
      rejected = err as { code?: string; reasons?: string[] };
    }

    expect(rejected?.code).toBe("CONFIG_WRITE_REJECTED");
    expect(rejected?.reasons).toContain("unreadable-config-before-write");
    expect(fsNode.readFileSync(configPath, "utf-8")).toBe(liveBytes);
  });
});
