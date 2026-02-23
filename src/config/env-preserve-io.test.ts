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

async function withWrapperEnvContext(configPath: string, run: () => Promise<void>): Promise<void> {
  await withEnvOverrides(
    {
      OPENCLAW_CONFIG_PATH: configPath,
      OPENCLAW_DISABLE_CONFIG_CACHE: "1",
      MY_API_KEY: "original-key-123",
    },
    run,
  );
}

function createGatewayTokenConfigJson(): string {
  return JSON.stringify({ gateway: { remote: { token: "${MY_API_KEY}" } } }, null, 2);
}

function createMutableApiKeyEnv(initialValue = "original-key-123"): Record<string, string> {
  return { MY_API_KEY: initialValue };
}

async function withGatewayTokenTempConfig(
  run: (configPath: string) => Promise<void>,
): Promise<void> {
  await withTempConfig(createGatewayTokenConfigJson(), run);
}

async function withWrapperGatewayTokenContext(
  run: (configPath: string) => Promise<void>,
): Promise<void> {
  await withGatewayTokenTempConfig(async (configPath) => {
    await withWrapperEnvContext(configPath, async () => run(configPath));
  });
}

async function readGatewayToken(configPath: string): Promise<string> {
  const written = await fs.readFile(configPath, "utf-8");
  const parsed = JSON.parse(written) as { gateway: { remote: { token: string } } };
  return parsed.gateway.remote.token;
}

describe("env snapshot TOCTOU via createConfigIO", () => {
  it("restores env refs using read-time env even after env mutation", async () => {
    const env = createMutableApiKeyEnv();
    await withGatewayTokenTempConfig(async (configPath) => {
      // Instance A: read config (captures env snapshot)
      const ioA = createConfigIO({ configPath, env: env as unknown as NodeJS.ProcessEnv });
      const firstRead = await ioA.readConfigFileSnapshotForWrite();
      expect(firstRead.snapshot.config.gateway?.remote?.token).toBe("original-key-123");

      // Mutate env between read and write
      env.MY_API_KEY = "mutated-key-456";

      // Instance B: write config using explicit read context from A
      const ioB = createConfigIO({ configPath, env: env as unknown as NodeJS.ProcessEnv });

      // Write the resolved config back — should restore ${MY_API_KEY}
      await ioB.writeConfigFile(firstRead.snapshot.config, firstRead.writeOptions);

      // Verify the written file still has ${MY_API_KEY}, not the resolved value
      const written = await fs.readFile(configPath, "utf-8");
      const parsed = JSON.parse(written);
      expect(parsed.gateway.remote.token).toBe("${MY_API_KEY}");
    });
  });

  it("without snapshot bridging, mutated env causes incorrect restoration", async () => {
    const env = createMutableApiKeyEnv();
    await withGatewayTokenTempConfig(async (configPath) => {
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
});

describe("gateway startup config write preserves env refs (issue #23307)", () => {
  it("preserves ${VAR} when config.env defines the referenced variable", async () => {
    // Simulates the gateway startup scenario: config.env sets a variable
    // that is also referenced via ${VAR} elsewhere in the same config.
    // The readConfigFileSnapshot flow applies config.env to process.env,
    // then resolves ${VAR} references. When writing back, the env snapshot
    // from read time must be used to correctly match and restore the ref.
    const configContent = JSON.stringify(
      {
        env: { MY_BOT_TOKEN: "secret-bot-token-123" },
        channels: { telegram: { botToken: "${MY_BOT_TOKEN}" } },
      },
      null,
      2,
    );

    await withTempConfig(configContent, async (configPath) => {
      const env = { OPENCLAW_DISABLE_CONFIG_CACHE: "1" } as Record<string, string | undefined>;
      // Ensure MY_BOT_TOKEN is NOT in the env before reading — it comes from config.env
      delete env.MY_BOT_TOKEN;

      const io = createConfigIO({ configPath, env: env as unknown as NodeJS.ProcessEnv });
      const readResult = await io.readConfigFileSnapshotForWrite();

      // After reading, config.env should have applied MY_BOT_TOKEN to the env object
      expect(env.MY_BOT_TOKEN).toBe("secret-bot-token-123");
      // The resolved config should have the token value
      expect(readResult.snapshot.config.channels?.telegram?.botToken).toBe("secret-bot-token-123");

      // Simulate gateway writing back the resolved config (e.g., after plugin auto-enable)
      await io.writeConfigFile(readResult.snapshot.config, readResult.writeOptions);

      // The written file must preserve ${MY_BOT_TOKEN}, not the resolved value
      const written = await fs.readFile(configPath, "utf-8");
      const parsed = JSON.parse(written);
      expect(parsed.channels.telegram.botToken).toBe("${MY_BOT_TOKEN}");
    });
  });

  it("leaks env var when writeOptions is not passed (demonstrates the bug)", async () => {
    const configContent = JSON.stringify(
      {
        env: { MY_BOT_TOKEN: "secret-bot-token-123" },
        channels: { telegram: { botToken: "${MY_BOT_TOKEN}" } },
      },
      null,
      2,
    );

    await withTempConfig(configContent, async (configPath) => {
      const env = { OPENCLAW_DISABLE_CONFIG_CACHE: "1" } as Record<string, string | undefined>;
      delete env.MY_BOT_TOKEN;

      const io = createConfigIO({ configPath, env: env as unknown as NodeJS.ProcessEnv });
      const readResult = await io.readConfigFileSnapshotForWrite();

      // Mutate the env to simulate a TOCTOU race (e.g., another config read
      // applied different config.env values, or the user changed the env var)
      env.MY_BOT_TOKEN = "different-token-456";

      // Write WITHOUT passing writeOptions — falls back to live env
      await io.writeConfigFile(readResult.snapshot.config);

      // Without the env snapshot, restoreEnvVarRefs uses live env where
      // MY_BOT_TOKEN="different-token-456", which doesn't match the incoming
      // value "secret-bot-token-123" — so the resolved value leaks to disk
      const written = await fs.readFile(configPath, "utf-8");
      const parsed = JSON.parse(written);
      expect(parsed.channels.telegram.botToken).toBe("secret-bot-token-123");
    });
  });
});

describe("env snapshot TOCTOU via wrapper APIs", () => {
  it("uses explicit read context even if another read interleaves", async () => {
    await withWrapperGatewayTokenContext(async (configPath) => {
      const firstRead = await readConfigFileSnapshotForWrite();
      expect(firstRead.snapshot.config.gateway?.remote?.token).toBe("original-key-123");

      // Interleaving read from another request context with a different env value.
      process.env.MY_API_KEY = "mutated-key-456";
      const secondRead = await readConfigFileSnapshotForWrite();
      expect(secondRead.snapshot.config.gateway?.remote?.token).toBe("mutated-key-456");

      // Write using the first read's explicit context.
      await writeConfigFileViaWrapper(firstRead.snapshot.config, firstRead.writeOptions);
      expect(await readGatewayToken(configPath)).toBe("${MY_API_KEY}");
    });
  });

  it("ignores read context when expected config path does not match", async () => {
    await withWrapperGatewayTokenContext(async (configPath) => {
      const firstRead = await readConfigFileSnapshotForWrite();
      expect(firstRead.snapshot.config.gateway?.remote?.token).toBe("original-key-123");
      expect(firstRead.writeOptions.expectedConfigPath).toBe(configPath);

      process.env.MY_API_KEY = "mutated-key-456";
      await writeConfigFileViaWrapper(firstRead.snapshot.config, {
        ...firstRead.writeOptions,
        expectedConfigPath: `${configPath}.different`,
      });

      expect(await readGatewayToken(configPath)).toBe("original-key-123");
    });
  });
});
