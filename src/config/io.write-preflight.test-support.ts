import fs from "node:fs/promises";
import path from "node:path";
import { expect, vi } from "vitest";
import { withEnvAsync } from "../test-utils/env.js";
import { setRuntimeConfigSnapshotRefreshHandler as setRefresh, writeConfigFile } from "./io.js";
import type { createConfigIO as CreateConfigIO } from "./io.js";
import type { OpenClawConfig } from "./types.js";

export function registerConfigWritePreflightTests({
  itWithHome,
  configPathForHome,
  formatConfig,
  createConfigIO,
  silentLogger,
}: {
  itWithHome: (name: string, testCase: (home: string) => Promise<void>) => void;
  configPathForHome: (home: string, fileName?: string) => string;
  formatConfig: (config: unknown) => string;
  createConfigIO: typeof CreateConfigIO;
  silentLogger: { warn: () => void; error: () => void };
}) {
  const gateway = () => ({ gateway: { mode: "local" as const, port: 19001 } });
  const unchanged = (file: string, raw: string) =>
    expect(fs.readFile(file, "utf8")).resolves.toBe(raw);
  const setPreflight = (preflight: NonNullable<Parameters<typeof setRefresh>[0]>["preflight"]) =>
    setRefresh({ preflight, refresh: () => true });
  function preflightTest(
    name: string,
    run: (file: string, raw: string, io: ReturnType<typeof createConfigIO>) => Promise<void>,
    ambient = true,
    config: unknown = { gateway: { mode: "local" } },
  ) {
    itWithHome(name, async (home) => {
      const configPath = configPathForHome(home);
      const initialRaw = formatConfig(config);
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await fs.writeFile(configPath, initialRaw, "utf-8");
      const env = {
        ...process.env,
        OPENCLAW_CONFIG_PATH: configPath,
        FINAL_WRITE_PREFIX: undefined,
      };
      const io = createConfigIO({ configPath, env, logger: silentLogger });
      try {
        await withEnvAsync(ambient ? { OPENCLAW_CONFIG_PATH: configPath } : {}, () =>
          run(configPath, initialRaw, io),
        );
      } finally {
        setRefresh(null);
      }
    });
  }

  for (const direct of [false, true]) {
    preflightTest(
      `blocks runtime preflight failures before ${direct ? "direct config IO" : "runtime"} commits root writes`,
      async (configPath, initialRaw, io) => {
        let observedSource: OpenClawConfig | undefined;
        const beforeCommit = vi.fn();
        const message = direct ? "missing direct IO secret" : "missing included secret";
        setPreflight(async ({ sourceConfig }) => {
          observedSource = sourceConfig;
          throw new Error(message);
        });
        await expect(
          direct
            ? io.writeConfigFile(gateway(), { beforeCommit })
            : writeConfigFile({ ...gateway(), logging: { level: "debug" } }),
        ).rejects.toThrow(`active SecretRef resolution failed: ${message}`);
        expect(observedSource?.gateway?.port).toBe(19001);
        if (direct) {
          expect(beforeCommit).not.toHaveBeenCalled();
        }
        await unchanged(configPath, initialRaw);
      },
      !direct,
    );
  }

  preflightTest(
    "runs a caller commit guard after runtime preflight and before the root write",
    async (configPath, initialRaw) => {
      const events: string[] = [];
      setPreflight(() => {
        events.push("runtime");
      });
      await expect(
        writeConfigFile(gateway(), {
          preCommitRuntimePreflight: async (sourceConfig) => {
            events.push(`caller:${String(sourceConfig.gateway?.port)}`);
            await unchanged(configPath, initialRaw);
            throw new Error("authority changed");
          },
        }),
      ).rejects.toThrow("authority changed");
      expect(events).toEqual(["runtime", "caller:19001"]);
      await unchanged(configPath, initialRaw);
    },
  );
  for (const included of [false, true]) {
    const key = "FINAL_WRITE_PREFIX";
    const messageConfig = { responsePrefix: "${FINAL_WRITE_PREFIX}" };
    preflightTest(
      `validates changed config-owned env at final preflight (include=${included})`,
      async (configPath, initialRaw, io) => {
        const leafPath = path.join(path.dirname(configPath), "messages.json");
        const leafRaw = JSON.stringify(messageConfig);
        if (included) {
          await fs.writeFile(leafPath, leafRaw);
        }
        const snapshot = await io.readConfigFileSnapshot();
        expect(snapshot.valid).toBe(true);
        let observedSource: OpenClawConfig | undefined;
        setPreflight(({ sourceConfig }) => {
          observedSource = sourceConfig;
        });
        await io.writeConfigFile(
          {
            ...snapshot.sourceConfig,
            env: { vars: { [key]: "new-prefix" } },
            messages: {
              ...snapshot.sourceConfig.messages,
              responsePrefix: "${FINAL_WRITE_PREFIX}",
            },
          },
          {
            inputBase: "source",
            baseSnapshot: snapshot,
            explicitSetPaths: [["env", "vars", key]],
          },
        );
        expect(observedSource?.messages?.responsePrefix).toBe("new-prefix");
        const reloaded = await createConfigIO({
          configPath,
          logger: silentLogger,
          env: { ...process.env, [key]: undefined },
        }).readConfigFileSnapshot();
        expect(reloaded.sourceConfig.messages?.responsePrefix).toBe("new-prefix");
        await unchanged(configPath + ".bak", initialRaw);
        if (included) {
          await unchanged(leafPath, leafRaw);
        }
      },
      false,
      {
        env: { vars: { [key]: "old-prefix" } },
        messages: included ? { $include: "./messages.json" } : messageConfig,
      },
    );
  }
}
