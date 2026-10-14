// Covers config IO permission-denied errors and recovery messaging.
import fsNode from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withEnvAsync } from "../test-utils/env.js";
import { createConfigIO, resetConfigRuntimeState, writeConfigFile } from "./io.js";
import type { OpenClawConfig } from "./types.openclaw.js";

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

  it("refuses an unreadable config even when size-drop writes are allowed", async () => {
    const home = fsNode.mkdtempSync(path.join(os.tmpdir(), "openclaw-unreadable-"));
    tempRoots.push(home);
    const stateDir = path.join(home, ".openclaw");
    fsNode.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    const configPath = path.join(stateDir, "openclaw.json");
    const liveConfig = {
      gateway: { mode: "local", port: 18789, auth: { mode: "token" } },
      channels: { telegram: { enabled: true } },
      agents: { entries: { main: {} } },
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

    const skeletal: OpenClawConfig = { channels: { telegram: { enabled: true } } };
    await expect(io.writeConfigFile(skeletal, { allowConfigSizeDrop: true })).rejects.toMatchObject(
      {
        code: "CONFIG_WRITE_REJECTED",
        reasons: expect.arrayContaining(["unreadable-config-before-write"]),
      },
    );
    expect(fsNode.readFileSync(configPath, "utf-8")).toBe(liveBytes);
    const rejectedArtifacts = fsNode
      .readdirSync(stateDir)
      .filter((name) => name.startsWith("openclaw.json.rejected."));
    expect(rejectedArtifacts).toHaveLength(1);
  });

  it.skipIf(process.platform === "win32")(
    "rejects exported writes before re-reading an unreadable base snapshot",
    async () => {
      const home = fsNode.mkdtempSync(path.join(os.tmpdir(), "openclaw-unreadable-"));
      tempRoots.push(home);
      const stateDir = path.join(home, ".openclaw");
      fsNode.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
      const configPath = path.join(stateDir, "openclaw.json");
      const liveConfig = {
        gateway: { mode: "local", port: 18789, auth: { mode: "token" } },
        meta: { lastTouchedVersion: "2026.5.3-1" },
      } satisfies OpenClawConfig;
      const liveBytes = `${JSON.stringify(liveConfig, null, 2)}\n`;
      fsNode.writeFileSync(configPath, liveBytes, { mode: 0o600 });

      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        fsNode.chmodSync(configPath, 0o000);
        await withEnvAsync(
          { OPENCLAW_CONFIG_PATH: configPath, OPENCLAW_TEST_FAST: "1" },
          async () => {
            await expect(
              writeConfigFile({ channels: { telegram: { enabled: true } } }),
            ).rejects.toMatchObject({
              code: "CONFIG_WRITE_REJECTED",
              reasons: expect.arrayContaining(["unreadable-config-before-write"]),
            });
          },
        );
      } finally {
        resetConfigRuntimeState();
        errorSpy.mockRestore();
        warnSpy.mockRestore();
        fsNode.chmodSync(configPath, 0o600);
      }

      expect(fsNode.readFileSync(configPath, "utf-8")).toBe(liveBytes);
      const rejectedArtifacts = fsNode
        .readdirSync(stateDir)
        .filter((name) => name.startsWith("openclaw.json.rejected."));
      expect(rejectedArtifacts).toHaveLength(1);
    },
  );
});
