import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import { VERSION } from "../version.js";
import { createConfigIO } from "./io.factory.js";
import type { ConfigIoFactoryOptions } from "./io.types.js";
import { normalizeExecSafeBinProfilesInConfig } from "./normalize-exec-safe-bin.js";

vi.mock("../commands/doctor/shared/legacy-config-compat.js", () => ({
  applyLegacyDoctorMigrations: () => {
    throw new Error("config IO compatibility tests must not enter recovery migration");
  },
}));

vi.mock("../plugins/plugin-metadata-snapshot.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/plugin-metadata-snapshot.js")>()),
  resolvePluginMetadataSnapshot: () => ({
    manifestRegistry: { plugins: [], diagnostics: [] },
  }),
}));

const roots = createTempDirTracker();
afterEach(() => roots.cleanup());

async function fixture(authored: unknown, extra: ConfigIoFactoryOptions = {}) {
  const home = roots.make("openclaw-config-compat-");
  const configPath = path.join(home, "openclaw.json");
  const logger = { error: vi.fn(), warn: vi.fn() };
  const options = {
    configPath,
    homedir: () => home,
    logger,
    ...extra,
    env: { HOME: home, ...extra.env },
  };
  const write = (config: unknown) => fs.writeFile(configPath, JSON.stringify(config, null, 2));
  await write(authored);
  return { configPath, logger, options, write, io: createConfigIO(options) };
}

describe("config io compatibility", () => {
  it("leaves retired context-budget shapes for Doctor instead of normalizing runtime reads", async () => {
    const authored = {
      models: {
        providers: {
          openai: {
            contextTokens: 64_000,
            contextWindow: 128_000,
            models: [{ id: "gpt-5.4", name: "GPT-5.4" }],
          },
        },
      },
      agents: {
        defaults: { contextTokens: 48_000 },
        entries: { ops: { contextTokens: 32_000 } },
      },
    };
    const { io, configPath } = await fixture(authored, { pluginValidation: "core-only" });
    const raw = await fs.readFile(configPath, "utf-8");
    expect(() => io.loadConfig()).toThrow(/contextTokens|contextWindow/);
    const snapshot = await io.readConfigFileSnapshot();
    expect(snapshot.valid).toBe(false);
    expect(snapshot.sourceConfig).toMatchObject(authored);
    expect(snapshot.sourceConfigBeforeMigrations).toMatchObject(authored);
    await expect(fs.readFile(configPath, "utf-8")).resolves.toBe(raw);
  });

  it("logs each warning payload once until warnings clear", async () => {
    const { logger, options, write } = await fixture({});
    const load = () => createConfigIO(options).loadConfig();
    const writeRemovedPlugin = (pluginId: string) =>
      write({ plugins: { entries: { [pluginId]: { enabled: false } } } });

    await writeRemovedPlugin("google-antigravity-auth");
    load();
    load();
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      "Config warnings: plugins.entries.google-antigravity-auth: plugin removed: google-antigravity-auth (stale config entry ignored; remove it from plugins config)",
    );

    createConfigIO({ ...options, pluginValidation: "skip" }).loadConfig();
    load();
    expect(logger.warn).toHaveBeenCalledTimes(1);

    await write({
      gateway: { port: "invalid" },
      plugins: { entries: { "google-antigravity-auth": { enabled: false } } },
    });
    expect(load).toThrow();
    await writeRemovedPlugin("google-antigravity-auth");
    load();
    expect(logger.warn).toHaveBeenCalledTimes(1);

    await writeRemovedPlugin("google-gemini-cli-auth");
    load();
    expect(logger.warn).toHaveBeenCalledTimes(2);

    await write({});
    load();
    await writeRemovedPlugin("google-gemini-cli-auth");
    load();
    expect(logger.warn).toHaveBeenCalledTimes(3);

    await write(null);
    expect(load).toThrow();
    await writeRemovedPlugin("google-gemini-cli-auth");
    load();
    expect(logger.warn).toHaveBeenCalledTimes(3);
  });

  it.each([undefined, "1"])("reports newer config unless update handoff is %s", async (handoff) => {
    const { io, logger } = await fixture(
      { meta: { lastTouchedVersion: "9999.1.1" }, gateway: { mode: "local" } },
      handoff ? { env: { OPENCLAW_UPDATE_POST_CORE: handoff } } : {},
    );
    io.loadConfig();
    if (handoff) {
      expect(logger.warn).not.toHaveBeenCalled();
    } else {
      expect(logger.warn).toHaveBeenCalledWith(
        [
          `Your OpenClaw config was written by version 9999.1.1, but this command is running ${VERSION}.`,
          "Check: `openclaw --version`, `which openclaw`, and `openclaw gateway status --deep`.",
          "If unexpected, update PATH so `openclaw` points to the version you want, or reinstall the Gateway service from that same OpenClaw install.",
        ].join("\n"),
      );
    }
  });

  it("normalizes safe-bin config entries at config load time", () => {
    const cfg = {
      tools: {
        exec: {
          safeBinTrustedDirs: [" /custom/bin ", "", "/custom/bin", "/agent/bin"],
          safeBinProfiles: {
            " MyFilter ": {
              allowedValueFlags: ["--limit", " --limit ", ""],
            },
          },
        },
      },
      agents: {
        entries: {
          ops: {
            tools: {
              exec: {
                safeBinTrustedDirs: [" /ops/bin ", "/ops/bin"],
                safeBinProfiles: {
                  " Custom ": {
                    deniedFlags: ["-f", " -f ", ""],
                  },
                },
              },
            },
          },
        },
      },
    };
    normalizeExecSafeBinProfilesInConfig(cfg);
    expect(cfg.tools?.exec?.safeBinProfiles).toEqual({
      myfilter: {
        allowedValueFlags: ["--limit"],
      },
    });
    expect(cfg.tools?.exec?.safeBinTrustedDirs).toEqual(["/custom/bin", "/agent/bin"]);
    expect(cfg.agents?.entries?.ops?.tools?.exec?.safeBinProfiles).toEqual({
      custom: {
        deniedFlags: ["-f"],
      },
    });
    expect(cfg.agents?.entries?.ops?.tools?.exec?.safeBinTrustedDirs).toEqual(["/ops/bin"]);
  });
});
