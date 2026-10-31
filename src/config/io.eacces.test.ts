import fsNode from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { withEnvAsync } from "../test-utils/env.js";
import { createConfigIO, resetConfigRuntimeState, writeConfigFile } from "./io.js";
import type { OpenClawConfig } from "./types.openclaw.js";

function makeUnreadableConfigFs(configPath: string): typeof fsNode {
  const eacces = Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
  const guard = <F extends (...args: never[]) => unknown>(read: F, async = false): F =>
    new Proxy(read, {
      apply(fn, self, args) {
        if (args[0] !== configPath) {
          return Reflect.apply(fn, self, args);
        }
        if (async) {
          return Promise.reject(eacces);
        }
        throw eacces;
      },
    });
  return {
    ...fsNode,
    readFileSync: guard(fsNode.readFileSync),
    promises: { ...fsNode.promises, readFile: guard(fsNode.promises.readFile, true) },
  };
}

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

  expect((await io.readConfigFileSnapshot()).readError).toEqual({ code: "EACCES" });

  const write = io.writeConfigFile(skeletal, { allowConfigSizeDrop: true });
  await expect(write).rejects.toMatchObject(rejection);
  expectPreserved(f);
});

it.skipIf(process.platform === "win32")(
  "rejects exported writes before re-reading an unreadable base snapshot",
  async () => {
    const f = fixture();

    const logs = (["error", "warn"] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation(() => {}),
    );
    try {
      fsNode.chmodSync(f.configPath, 0o000);
      await withEnvAsync({ OPENCLAW_CONFIG_PATH: f.configPath, OPENCLAW_TEST_FAST: "1" }, () =>
        expect(writeConfigFile(skeletal)).rejects.toMatchObject(rejection),
      );
    } finally {
      resetConfigRuntimeState();
      logs.forEach((spy) => spy.mockRestore());
      fsNode.chmodSync(f.configPath, 0o600);
    }

    expectPreserved(f);
  },
);
