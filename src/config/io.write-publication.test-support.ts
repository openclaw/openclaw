import fsNode from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { expect } from "vitest";
import type { createConfigIO as CreateConfigIO } from "./io.js";
import type { OpenClawConfig } from "./types.js";

type ConfigIoFactory = (
  home: string,
  options?: Parameters<typeof CreateConfigIO>[0],
) => ReturnType<typeof CreateConfigIO>;

export function registerConfigWritePublicationTests({
  itWithHome,
  writeConfigFixture,
  createFastConfigIO,
  createHomeConfigIO,
  readPersistedConfig,
  formatConfig,
}: {
  itWithHome: (name: string, testCase: (home: string) => Promise<void>) => void;
  writeConfigFixture: (
    home: string,
    config: unknown,
  ) => Promise<{ configPath: string; raw: string }>;
  createFastConfigIO: ConfigIoFactory;
  createHomeConfigIO: ConfigIoFactory;
  readPersistedConfig: (configPath: string) => Promise<OpenClawConfig>;
  formatConfig: (config: unknown) => string;
}) {
  itWithHome("replaces a hardlinked root config without changing its other alias", async (home) => {
    const { configPath, raw } = await writeConfigFixture(home, {
      gateway: { mode: "local", port: 18789 },
    });
    const aliasPath = path.join(home, "shared-config.json");
    await fs.link(configPath, aliasPath);

    await createFastConfigIO(home).writeConfigFile({
      gateway: { mode: "local", port: 19002 },
    });

    expect((await readPersistedConfig(configPath)).gateway?.port).toBe(19002);
    await expect(fs.readFile(aliasPath, "utf-8")).resolves.toBe(raw);
  });

  itWithHome("rolls back a config renamed before publication verification fails", async (home) => {
    const { configPath, raw } = await writeConfigFixture(home, {
      gateway: { mode: "local", port: 18789 },
    });
    const failure = Object.assign(new Error("publication verification failed"), { code: "EIO" });
    let verifyRenamed = false;
    let injected = false;
    const io = createFastConfigIO(home, {
      fs: {
        ...fsNode,
        renameSync(source, destination) {
          fsNode.renameSync(source, destination);
          if (destination === configPath) {
            verifyRenamed = true;
          }
        },
        fstatSync: new Proxy(fsNode.fstatSync, {
          apply(target, thisArg, args) {
            if (verifyRenamed && !injected) {
              injected = true;
              throw failure;
            }
            return Reflect.apply(target, thisArg, args);
          },
        }),
      },
    });

    await expect(
      io.writeConfigFile({ gateway: { mode: "local", port: 19002 } }),
    ).rejects.toMatchObject({
      name: "ConfigWritePostCommitError",
      configPath,
      rollbackStatus: "restored",
      cause: failure,
    });
    expect(injected).toBe(true);
    await expect(fs.readFile(configPath, "utf-8")).resolves.toBe(raw);
  });

  itWithHome("rejects a stale base snapshot before overwriting the root config", async (home) => {
    const { configPath } = await writeConfigFixture(home, {
      gateway: { mode: "local", port: 18789 },
    });
    const io = createFastConfigIO(home);
    const snapshot = await io.readConfigFileSnapshot();
    const concurrentRaw = formatConfig({ gateway: { mode: "local", port: 19001 } });
    await fs.writeFile(configPath, concurrentRaw, "utf-8");

    await expect(
      io.writeConfigFile({ gateway: { mode: "local", port: 19002 } }, { baseSnapshot: snapshot }),
    ).rejects.toThrow("config changed since last load");

    await expect(fs.readFile(configPath, "utf-8")).resolves.toBe(concurrentRaw);
  });

  itWithHome(
    "rejects a base snapshot from a different config path before overwriting the root config",
    async (home) => {
      const firstConfigPath = path.join(home, ".openclaw", "first.json");
      const secondConfigPath = path.join(home, ".openclaw", "second.json");
      await fs.mkdir(path.dirname(firstConfigPath), { recursive: true });
      const originalRaw = formatConfig({ gateway: { mode: "local", port: 18789 } });
      await fs.writeFile(firstConfigPath, originalRaw, "utf-8");
      await fs.writeFile(secondConfigPath, originalRaw, "utf-8");
      const firstIo = createHomeConfigIO(home, {
        configPath: firstConfigPath,
        env: { OPENCLAW_TEST_FAST: "1" } as NodeJS.ProcessEnv,
      });
      const secondIo = createHomeConfigIO(home, {
        configPath: secondConfigPath,
        env: { OPENCLAW_TEST_FAST: "1" } as NodeJS.ProcessEnv,
      });
      const firstSnapshot = await firstIo.readConfigFileSnapshot();

      await expect(
        secondIo.writeConfigFile(
          { gateway: { mode: "local", port: 19002 } },
          { baseSnapshot: firstSnapshot },
        ),
      ).rejects.toThrow("config path changed since last load");

      await expect(fs.readFile(secondConfigPath, "utf-8")).resolves.toBe(originalRaw);
    },
  );
}
