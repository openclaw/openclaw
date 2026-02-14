import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it, expect } from "vitest";
import {
  createConfigIO,
  readConfigFileSnapshotForWrite,
  writeConfigFile as writeConfigFileViaWrapper,
} from "./io.js";

async function withTempConfig(
  configContent: string,
  run: (configPath: string) => Promise<void>,
): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-env-io-"));
  const configPath = path.join(dir, "openclaw.json");
  await fs.writeFile(configPath, configContent);
  try {
    await run(configPath);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function withEnvOverrides(
  updates: Record<string, string | undefined>,
  run: () => Promise<void>,
): Promise<void> {
  const previous = new Map<string, string | undefined>();
  for (const key of Object.keys(updates)) {
    previous.set(key, process.env[key]);
  }

  try {
    for (const [key, value] of Object.entries(updates)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    await run();
  } finally {
    for (const [key, value] of previous.entries()) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

describe("env snapshot TOCTOU via createConfigIO", () => {
  it("restores env refs using read-time env even after env mutation", async () => {
    const env: Record<string, string> = {
      MY_API_KEY: "original-key-123",
    };

    const configJson = JSON.stringify({ gateway: { remote: { token: "${MY_API_KEY}" } } }, null, 2);

    await withTempConfig(configJson, async (configPath) => {
      // Instance A: read config (captures env snapshot)
      const ioA = createConfigIO({ configPath, env: env as unknown as NodeJS.ProcessEnv });
      const snapshot = await ioA.readConfigFileSnapshot();
      const envSnap = ioA.getEnvSnapshot();
      expect(snapshot.config.gateway?.remote?.token).toBe("original-key-123");

      // Mutate env between read and write
      env.MY_API_KEY = "mutated-key-456";

      // Instance B: write config using explicit env snapshot from A
      const ioB = createConfigIO({ configPath, env: env as unknown as NodeJS.ProcessEnv });
      if (envSnap) {
        ioB.setEnvSnapshot(envSnap);
      }

      // Write the resolved config back — should restore ${MY_API_KEY}
      await ioB.writeConfigFile(snapshot.config);

      // Verify the written file still has ${MY_API_KEY}, not the resolved value
      const written = await fs.readFile(configPath, "utf-8");
      const parsed = JSON.parse(written);
      expect(parsed.gateway.remote.token).toBe("${MY_API_KEY}");
    });
  });

  it("without snapshot bridging, mutated env causes incorrect restoration", async () => {
    const env: Record<string, string> = {
      MY_API_KEY: "original-key-123",
    };

    const configJson = JSON.stringify({ gateway: { remote: { token: "${MY_API_KEY}" } } }, null, 2);

    await withTempConfig(configJson, async (configPath) => {
      // Instance A: read config
      const ioA = createConfigIO({ configPath, env: env as unknown as NodeJS.ProcessEnv });
      const snapshot = await ioA.readConfigFileSnapshot();

      // Mutate env
      env.MY_API_KEY = "mutated-key-456";

      // Instance B: write WITHOUT snapshot bridging (simulates the old bug)
      const ioB = createConfigIO({ configPath, env: env as unknown as NodeJS.ProcessEnv });
      // No explicit writeOptions — ioB uses live env

      await ioB.writeConfigFile(snapshot.config);

      // The written file should have the raw value because the live env
      // no longer matches — restoreEnvVarRefs won't find a match
      const written = await fs.readFile(configPath, "utf-8");
      const parsed = JSON.parse(written);
      // Without snapshot, the resolved value "original-key-123" doesn't match
      // live env "mutated-key-456", so restoration fails — value is written as-is
      expect(parsed.gateway.remote.token).toBe("original-key-123");
    });
  });

  it("env snapshot is reusable across multiple writes in the same read cycle", async () => {
    const env: Record<string, string> = {
      MY_TOKEN: "secret-abc",
    };

    const configJson = JSON.stringify({ gateway: { auth: { token: "${MY_TOKEN}" } } }, null, 2);

    await withTempConfig(configJson, async (configPath) => {
      // Read config — captures env snapshot
      const ioRead = createConfigIO({ configPath, env: env as unknown as NodeJS.ProcessEnv });
      const snapshot = await ioRead.readConfigFileSnapshot();
      const envSnap = ioRead.getEnvSnapshot();

      // Mutate env between read and writes
      env.MY_TOKEN = "mutated-xyz";

      // First write with snapshot bridging
      const ioWrite1 = createConfigIO({ configPath, env: env as unknown as NodeJS.ProcessEnv });
      if (envSnap) {
        ioWrite1.setEnvSnapshot(envSnap);
      }
      await ioWrite1.writeConfigFile(snapshot.config);

      const written1 = await fs.readFile(configPath, "utf-8");
      const parsed1 = JSON.parse(written1);
      expect(parsed1.gateway.auth.token).toBe("${MY_TOKEN}");

      // Second write — reuse the SAME snapshot (simulates retained snapshot)
      const ioWrite2 = createConfigIO({ configPath, env: env as unknown as NodeJS.ProcessEnv });
      if (envSnap) {
        ioWrite2.setEnvSnapshot(envSnap);
      }
      await ioWrite2.writeConfigFile(snapshot.config);

      const written2 = await fs.readFile(configPath, "utf-8");
      const parsed2 = JSON.parse(written2);
      // Should still restore correctly — snapshot wasn't consumed/deleted
      expect(parsed2.gateway.auth.token).toBe("${MY_TOKEN}");
    });
  });
});

describe("env snapshot TOCTOU via wrapper APIs", () => {
  it("uses explicit read context even if another read interleaves", async () => {
    const configJson = JSON.stringify({ gateway: { remote: { token: "${MY_API_KEY}" } } }, null, 2);
    await withTempConfig(configJson, async (configPath) => {
      await withEnvOverrides(
        {
          OPENCLAW_CONFIG_PATH: configPath,
          OPENCLAW_DISABLE_CONFIG_CACHE: "1",
          MY_API_KEY: "original-key-123",
        },
        async () => {
          const firstRead = await readConfigFileSnapshotForWrite();
          expect(firstRead.snapshot.config.gateway?.remote?.token).toBe("original-key-123");

          // Interleaving read from another request context with a different env value.
          process.env.MY_API_KEY = "mutated-key-456";
          const secondRead = await readConfigFileSnapshotForWrite();
          expect(secondRead.snapshot.config.gateway?.remote?.token).toBe("mutated-key-456");

          // Write using the first read's explicit context.
          await writeConfigFileViaWrapper(firstRead.snapshot.config, firstRead.writeOptions);
          const written = await fs.readFile(configPath, "utf-8");
          const parsed = JSON.parse(written);
          expect(parsed.gateway.remote.token).toBe("${MY_API_KEY}");
        },
      );
    });
  });

  it("ignores read context when expected config path does not match", async () => {
    const configJson = JSON.stringify({ gateway: { remote: { token: "${MY_API_KEY}" } } }, null, 2);
    await withTempConfig(configJson, async (configPath) => {
      await withEnvOverrides(
        {
          OPENCLAW_CONFIG_PATH: configPath,
          OPENCLAW_DISABLE_CONFIG_CACHE: "1",
          MY_API_KEY: "original-key-123",
        },
        async () => {
          const firstRead = await readConfigFileSnapshotForWrite();
          expect(firstRead.snapshot.config.gateway?.remote?.token).toBe("original-key-123");
          expect(firstRead.writeOptions.expectedConfigPath).toBe(configPath);

          process.env.MY_API_KEY = "mutated-key-456";
          await writeConfigFileViaWrapper(firstRead.snapshot.config, {
            ...firstRead.writeOptions,
            expectedConfigPath: `${configPath}.different`,
          });

          const written = await fs.readFile(configPath, "utf-8");
          const parsed = JSON.parse(written);
          expect(parsed.gateway.remote.token).toBe("original-key-123");
        },
      );
    });
  });
});
