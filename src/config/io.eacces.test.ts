import fsNode from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
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
  const readFile = (async (target: unknown, options?: unknown) => {
    if (target === configPath) {
      throw eacces;
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
  const tempRoots = useAutoCleanupTempDirTracker(afterEach);
  function fixture(extra: Partial<OpenClawConfig> = {}) {
    const home = tempRoots.make("openclaw-unreadable-");
    const stateDir = path.join(home, ".openclaw");
    fsNode.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    const configPath = path.join(stateDir, "openclaw.json");
    const liveConfig = {
      gateway: { mode: "local", port: 18789, auth: { mode: "token" } },
      meta: { lastTouchedVersion: "2026.5.3-1" },
      ...extra,
    } satisfies OpenClawConfig;
    const liveBytes = `${JSON.stringify(liveConfig, null, 2)}\n`;
    fsNode.writeFileSync(configPath, liveBytes, { mode: 0o600 });
    return { home, stateDir, configPath, liveBytes };
  }
  function expectPreserved({ configPath, stateDir, liveBytes }: ReturnType<typeof fixture>) {
    expect(fsNode.readFileSync(configPath, "utf-8")).toBe(liveBytes);
    expect(
      fsNode.readdirSync(stateDir).filter((name) => name.startsWith("openclaw.json.rejected.")),
    ).toHaveLength(1);
  }
  const rejection = {
    code: "CONFIG_WRITE_REJECTED",
    reasons: expect.arrayContaining(["unreadable-config-before-write"]),
  };
  const skeletal: OpenClawConfig = { channels: { telegram: { enabled: true } } };

  it("refuses an unreadable config even when size-drop writes are allowed", async () => {
    const f = fixture({ ...skeletal, agents: { entries: { main: {} } } });
    const io = createConfigIO({
      configPath: f.configPath,
      fs: makeUnreadableConfigFs(f.configPath),
      homedir: () => f.home,
      env: {},
      observe: false,
      logger: { error: () => {}, warn: () => {} },
    });

    const snapshot = await io.readConfigFileSnapshot();
    expect(snapshot.readError).toEqual({ code: "EACCES" });

    await expect(io.writeConfigFile(skeletal, { allowConfigSizeDrop: true })).rejects.toMatchObject(
      rejection,
    );
    expectPreserved(f);
  });

  it.skipIf(process.platform === "win32")(
    "rejects exported writes before re-reading an unreadable base snapshot",
    async () => {
      const f = fixture();

      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        fsNode.chmodSync(f.configPath, 0o000);
        await withEnvAsync(
          { OPENCLAW_CONFIG_PATH: f.configPath, OPENCLAW_TEST_FAST: "1" },
          async () => {
            await expect(writeConfigFile(skeletal)).rejects.toMatchObject(rejection);
          },
        );
      } finally {
        resetConfigRuntimeState();
        errorSpy.mockRestore();
        warnSpy.mockRestore();
        fsNode.chmodSync(f.configPath, 0o600);
      }

      expectPreserved(f);
    },
  );
});
