import fs from "node:fs/promises";
import path from "node:path";
import { expect, vi } from "vitest";
import { withEnvAsync } from "../test-utils/env.js";
import { setRuntimeConfigSnapshotRefreshHandler, writeConfigFile } from "./io.js";
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
  itWithHome("blocks runtime preflight failures before committing root writes", async (home) => {
    const configPath = configPathForHome(home);
    const initialRaw = formatConfig({ gateway: { mode: "local" } });
    let observedSource: OpenClawConfig | undefined;

    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(configPath, initialRaw, "utf-8");

    try {
      await withEnvAsync({ OPENCLAW_CONFIG_PATH: configPath }, async () => {
        setRuntimeConfigSnapshotRefreshHandler({
          preflight: async ({ sourceConfig }) => {
            observedSource = sourceConfig;
            throw new Error("missing included secret");
          },
          refresh: () => true,
        });

        await expect(
          writeConfigFile({
            gateway: { mode: "local", port: 19001 },
            logging: { level: "debug" },
          }),
        ).rejects.toThrow(/active SecretRef resolution failed: missing included secret/);

        expect(observedSource?.gateway?.port).toBe(19001);
        await expect(fs.readFile(configPath, "utf-8")).resolves.toBe(initialRaw);
      });
    } finally {
      setRuntimeConfigSnapshotRefreshHandler(null);
    }
  });

  itWithHome(
    "runs a caller commit guard after runtime preflight and before the root write",
    async (home) => {
      const configPath = configPathForHome(home);
      const initialRaw = formatConfig({ gateway: { mode: "local" } });
      const events: string[] = [];

      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await fs.writeFile(configPath, initialRaw, "utf-8");

      try {
        await withEnvAsync({ OPENCLAW_CONFIG_PATH: configPath }, async () => {
          setRuntimeConfigSnapshotRefreshHandler({
            preflight: () => {
              events.push("runtime");
            },
            refresh: () => true,
          });

          await expect(
            writeConfigFile(
              { gateway: { mode: "local", port: 19001 } },
              {
                preCommitRuntimePreflight: async (sourceConfig) => {
                  events.push(`caller:${String(sourceConfig.gateway?.port)}`);
                  await expect(fs.readFile(configPath, "utf-8")).resolves.toBe(initialRaw);
                  throw new Error("authority changed");
                },
              },
            ),
          ).rejects.toThrow("authority changed");

          expect(events).toEqual(["runtime", "caller:19001"]);
          await expect(fs.readFile(configPath, "utf-8")).resolves.toBe(initialRaw);
        });
      } finally {
        setRuntimeConfigSnapshotRefreshHandler(null);
      }
    },
  );

  itWithHome(
    "blocks runtime preflight failures before direct config IO commits root writes",
    async (home) => {
      const configPath = configPathForHome(home);
      const initialRaw = formatConfig({ gateway: { mode: "local" } });
      const env = {
        ...process.env,
        OPENCLAW_CONFIG_PATH: configPath,
      } as NodeJS.ProcessEnv;
      let observedSource: OpenClawConfig | undefined;
      const beforeCommit = vi.fn();

      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await fs.writeFile(configPath, initialRaw, "utf-8");

      try {
        setRuntimeConfigSnapshotRefreshHandler({
          preflight: async ({ sourceConfig }) => {
            observedSource = sourceConfig;
            throw new Error("missing direct IO secret");
          },
          refresh: () => true,
        });

        await expect(
          createConfigIO({ env, logger: silentLogger }).writeConfigFile(
            { gateway: { mode: "local", port: 19001 } },
            { beforeCommit },
          ),
        ).rejects.toThrow(/active SecretRef resolution failed: missing direct IO secret/);

        expect(observedSource?.gateway?.port).toBe(19001);
        expect(beforeCommit).not.toHaveBeenCalled();
        await expect(fs.readFile(configPath, "utf-8")).resolves.toBe(initialRaw);
      } finally {
        setRuntimeConfigSnapshotRefreshHandler(null);
      }
    },
  );

  for (const included of [false, true]) {
    itWithHome(
      `validates changed config-owned env at final preflight (include=${included})`,
      async (home) => {
        const configPath = configPathForHome(home);
        const key = "FINAL_WRITE_PREFIX";
        const messageConfig = { responsePrefix: "${FINAL_WRITE_PREFIX}" };
        const initialRaw = formatConfig({
          env: { vars: { [key]: "old-prefix" } },
          messages: included ? { $include: "./messages.json" } : messageConfig,
        });
        const leafPath = path.join(path.dirname(configPath), "messages.json");
        const leafRaw = JSON.stringify(messageConfig);
        await fs.mkdir(path.dirname(configPath), { recursive: true });
        await fs.writeFile(configPath, initialRaw);
        if (included) {
          await fs.writeFile(leafPath, leafRaw);
        }
        const env: NodeJS.ProcessEnv = {
          ...process.env,
          [key]: undefined,
          OPENCLAW_CONFIG_PATH: configPath,
        };
        const io = createConfigIO({ env, configPath, logger: silentLogger });
        const snapshot = await io.readConfigFileSnapshot();
        expect(snapshot.valid).toBe(true);
        let observedSource: OpenClawConfig | undefined;
        try {
          setRuntimeConfigSnapshotRefreshHandler({
            preflight: ({ sourceConfig }) => {
              observedSource = sourceConfig;
            },
            refresh: () => true,
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
          await expect(fs.readFile(configPath + ".bak", "utf8")).resolves.toBe(initialRaw);
          if (included) {
            await expect(fs.readFile(leafPath, "utf8")).resolves.toBe(leafRaw);
          }
        } finally {
          setRuntimeConfigSnapshotRefreshHandler(null);
        }
      },
    );
  }
}
