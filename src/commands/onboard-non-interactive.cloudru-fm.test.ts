import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import { CLOUDRU_FM_PRESETS, CLOUDRU_PROXY_SENTINEL_KEY } from "../config/cloudru-fm.constants.js";

type RuntimeMock = {
  log: () => void;
  error: (msg: string) => never;
  exit: (code: number) => never;
};

type EnvSnapshot = {
  home: string | undefined;
  stateDir: string | undefined;
  configPath: string | undefined;
  skipChannels: string | undefined;
  skipGmail: string | undefined;
  skipCron: string | undefined;
  skipCanvas: string | undefined;
  token: string | undefined;
  password: string | undefined;
  cloudruApiKey: string | undefined;
  disableConfigCache: string | undefined;
};

type OnboardEnv = {
  configPath: string;
  runtime: RuntimeMock;
};

async function removeDirWithRetry(dir: string): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await fs.rm(dir, { recursive: true, force: true });
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const isTransient = code === "ENOTEMPTY" || code === "EBUSY" || code === "EPERM";
      if (!isTransient || attempt === 4) {
        throw error;
      }
      await delay(25 * (attempt + 1));
    }
  }
}

function captureEnv(): EnvSnapshot {
  return {
    home: process.env.HOME,
    stateDir: process.env.OPENCLAW_STATE_DIR,
    configPath: process.env.OPENCLAW_CONFIG_PATH,
    skipChannels: process.env.OPENCLAW_SKIP_CHANNELS,
    skipGmail: process.env.OPENCLAW_SKIP_GMAIL_WATCHER,
    skipCron: process.env.OPENCLAW_SKIP_CRON,
    skipCanvas: process.env.OPENCLAW_SKIP_CANVAS_HOST,
    token: process.env.OPENCLAW_GATEWAY_TOKEN,
    password: process.env.OPENCLAW_GATEWAY_PASSWORD,
    cloudruApiKey: process.env.CLOUDRU_API_KEY,
    disableConfigCache: process.env.OPENCLAW_DISABLE_CONFIG_CACHE,
  };
}

function restoreEnvVar(key: keyof NodeJS.ProcessEnv, value: string | undefined): void {
  if (value == null) {
    delete process.env[key];
    return;
  }
  process.env[key] = value;
}

function restoreEnv(prev: EnvSnapshot): void {
  restoreEnvVar("HOME", prev.home);
  restoreEnvVar("OPENCLAW_STATE_DIR", prev.stateDir);
  restoreEnvVar("OPENCLAW_CONFIG_PATH", prev.configPath);
  restoreEnvVar("OPENCLAW_SKIP_CHANNELS", prev.skipChannels);
  restoreEnvVar("OPENCLAW_SKIP_GMAIL_WATCHER", prev.skipGmail);
  restoreEnvVar("OPENCLAW_SKIP_CRON", prev.skipCron);
  restoreEnvVar("OPENCLAW_SKIP_CANVAS_HOST", prev.skipCanvas);
  restoreEnvVar("OPENCLAW_GATEWAY_TOKEN", prev.token);
  restoreEnvVar("OPENCLAW_GATEWAY_PASSWORD", prev.password);
  restoreEnvVar("CLOUDRU_API_KEY", prev.cloudruApiKey);
  restoreEnvVar("OPENCLAW_DISABLE_CONFIG_CACHE", prev.disableConfigCache);
}

async function withOnboardEnv(
  prefix: string,
  run: (ctx: OnboardEnv) => Promise<void>,
): Promise<void> {
  const prev = captureEnv();

  process.env.OPENCLAW_SKIP_CHANNELS = "1";
  process.env.OPENCLAW_SKIP_GMAIL_WATCHER = "1";
  process.env.OPENCLAW_SKIP_CRON = "1";
  process.env.OPENCLAW_SKIP_CANVAS_HOST = "1";
  process.env.OPENCLAW_DISABLE_CONFIG_CACHE = "1";
  delete process.env.OPENCLAW_GATEWAY_TOKEN;
  delete process.env.OPENCLAW_GATEWAY_PASSWORD;

  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const configPath = path.join(tempHome, "openclaw.json");
  process.env.HOME = tempHome;
  process.env.OPENCLAW_STATE_DIR = tempHome;
  process.env.OPENCLAW_CONFIG_PATH = configPath;
  vi.resetModules();

  const runtime: RuntimeMock = {
    log: () => {},
    error: (msg: string) => {
      throw new Error(msg);
    },
    exit: (code: number) => {
      throw new Error(`exit:${code}`);
    },
  };

  try {
    await run({ configPath, runtime });
  } finally {
    await removeDirWithRetry(tempHome);
    restoreEnv(prev);
  }
}

async function runNonInteractive(
  options: Record<string, unknown>,
  runtime: RuntimeMock,
): Promise<void> {
  const { runNonInteractiveOnboarding } = await import("./onboard-non-interactive.js");
  await runNonInteractiveOnboarding(options, runtime);
}

async function readJsonFile<T>(filePath: string): Promise<T> {
  return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
}

describe("onboard (non-interactive): Cloud.ru FM", () => {
  it("configures cloudru-fm-glm47 with provider, proxy env, and model fallbacks", async () => {
    await withOnboardEnv("cloudru-glm47-", async ({ configPath, runtime }) => {
      process.env.CLOUDRU_API_KEY = "test-cloudru-api-key-12345";

      await runNonInteractive(
        {
          nonInteractive: true,
          acceptRisk: true,
          mode: "local",
          authChoice: "cloudru-fm-glm47",
          skipHealth: true,
          skipChannels: true,
          skipSkills: true,
          installDaemon: false,
          skipAiFabric: true,
        },
        runtime,
      );

      const config = await readJsonFile<Record<string, unknown>>(configPath);

      // Verify cloudru-fm provider is configured
      const models = config["models"] as Record<string, unknown>;
      const providers = models["providers"] as Record<string, unknown>;
      expect(providers["cloudru-fm"]).toBeDefined();

      const cloudruProvider = providers["cloudru-fm"] as Record<string, unknown>;
      expect(cloudruProvider["api"]).toBe("anthropic-messages");
      expect(cloudruProvider["apiKey"]).toBe("${CLOUDRU_API_KEY}");

      // Verify model IDs match the GLM-4.7 preset
      const preset = CLOUDRU_FM_PRESETS["cloudru-fm-glm47"];
      const providerModels = cloudruProvider["models"] as Array<{ id: string }>;
      const modelIds = providerModels.map((m) => m.id);
      expect(modelIds).toContain(preset.big);
      expect(modelIds).toContain(preset.middle);
      expect(modelIds).toContain(preset.small);

      // Verify claude-cli backend proxy env
      const agents = config["agents"] as Record<string, unknown>;
      const defaults = agents["defaults"] as Record<string, unknown>;
      const cliBackends = defaults["cliBackends"] as Record<string, unknown>;
      const claudeCli = cliBackends["claude-cli"] as Record<string, unknown>;
      const env = claudeCli["env"] as Record<string, string>;
      expect(env["ANTHROPIC_BASE_URL"]).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      expect(env["ANTHROPIC_API_KEY"]).toBe(CLOUDRU_PROXY_SENTINEL_KEY);

      // Verify clearEnv blocks real keys from leaking
      const clearEnv = claudeCli["clearEnv"] as string[];
      expect(clearEnv).toContain("ANTHROPIC_API_KEY");
      expect(clearEnv).toContain("ANTHROPIC_API_KEY_OLD");

      // Verify model fallback chain
      const model = defaults["model"] as Record<string, unknown>;
      expect(model["primary"]).toContain(preset.big);
      const fallbacks = model["fallbacks"] as string[];
      expect(fallbacks.some((f) => f.includes(preset.middle))).toBe(true);
      expect(fallbacks.some((f) => f.includes(preset.small))).toBe(true);
    });
  });

  it("configures cloudru-fm-flash preset with correct model IDs", async () => {
    await withOnboardEnv("cloudru-flash-", async ({ configPath, runtime }) => {
      process.env.CLOUDRU_API_KEY = "test-flash-key";

      await runNonInteractive(
        {
          nonInteractive: true,
          acceptRisk: true,
          mode: "local",
          authChoice: "cloudru-fm-flash",
          skipHealth: true,
          skipChannels: true,
          skipSkills: true,
          installDaemon: false,
          skipAiFabric: true,
        },
        runtime,
      );

      const config = await readJsonFile<Record<string, unknown>>(configPath);
      const models = config["models"] as Record<string, unknown>;
      const providers = models["providers"] as Record<string, unknown>;
      const cloudruProvider = providers["cloudru-fm"] as Record<string, unknown>;
      const providerModels = cloudruProvider["models"] as Array<{ id: string }>;
      const modelIds = providerModels.map((m) => m.id);

      const preset = CLOUDRU_FM_PRESETS["cloudru-fm-flash"];
      expect(modelIds).toContain(preset.big);
      expect(modelIds).toContain(preset.middle);
      expect(modelIds).toContain(preset.small);
    });
  });

  it("configures cloudru-fm-qwen preset with correct model IDs", async () => {
    await withOnboardEnv("cloudru-qwen-", async ({ configPath, runtime }) => {
      process.env.CLOUDRU_API_KEY = "test-qwen-key";

      await runNonInteractive(
        {
          nonInteractive: true,
          acceptRisk: true,
          mode: "local",
          authChoice: "cloudru-fm-qwen",
          skipHealth: true,
          skipChannels: true,
          skipSkills: true,
          installDaemon: false,
          skipAiFabric: true,
        },
        runtime,
      );

      const config = await readJsonFile<Record<string, unknown>>(configPath);
      const models = config["models"] as Record<string, unknown>;
      const providers = models["providers"] as Record<string, unknown>;
      const cloudruProvider = providers["cloudru-fm"] as Record<string, unknown>;
      const providerModels = cloudruProvider["models"] as Array<{ id: string }>;
      const modelIds = providerModels.map((m) => m.id);

      const preset = CLOUDRU_FM_PRESETS["cloudru-fm-qwen"];
      expect(modelIds).toContain(preset.big);
      expect(modelIds).toContain(preset.middle);
      expect(modelIds).toContain(preset.small);
    });
  });

  it("sets gateway mode to local in config", async () => {
    await withOnboardEnv("cloudru-gw-", async ({ configPath, runtime }) => {
      process.env.CLOUDRU_API_KEY = "test-gw-key";

      await runNonInteractive(
        {
          nonInteractive: true,
          acceptRisk: true,
          mode: "local",
          authChoice: "cloudru-fm-glm47",
          skipHealth: true,
          skipChannels: true,
          skipSkills: true,
          installDaemon: false,
          skipAiFabric: true,
        },
        runtime,
      );

      const config = await readJsonFile<Record<string, unknown>>(configPath);
      const gateway = config["gateway"] as Record<string, unknown>;
      expect(gateway["mode"]).toBe("local");
    });
  });
});
