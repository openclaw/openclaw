import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
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

it("leaves retired context-budget shapes for Doctor instead of normalizing runtime reads", async () => {
  const provider = {
    contextTokens: 64_000,
    contextWindow: 128_000,
    models: [{ id: "gpt-5.4", name: "GPT-5.4" }],
  };
  const authored = {
    models: { providers: { openai: provider } },
    agents: {
      defaults: { contextTokens: 48_000 },
      entries: { ops: { contextTokens: 32_000 } },
    },
  };
  const { io, configPath } = await fixture(authored, { pluginValidation: "core-only" });
  const raw = await fs.readFile(configPath, "utf-8");
  expect(() => io.loadConfig()).toThrow(/contextTokens|contextWindow/);
  const snapshot = await io.readConfigFileSnapshot();
  expect(snapshot).toMatchObject({
    valid: false,
    sourceConfig: authored,
    sourceConfigBeforeMigrations: authored,
  });
  await expect(fs.readFile(configPath, "utf-8")).resolves.toBe(raw);
});

it("logs each warning payload once until warnings clear", async () => {
  const { io, logger, options, write } = await fixture({});
  const load = () => createConfigIO(options).loadConfig();
  const removed = (pluginId: string) => ({
    plugins: { entries: { [pluginId]: { enabled: false } } },
  });
  const checkWarning = async (pluginId: string, count: number) => {
    await write(removed(pluginId));
    load();
    expect(logger.warn).toHaveBeenCalledTimes(count);
  };

  await write(removed("google-antigravity-auth"));
  load();
  load();
  expect(logger.warn).toHaveBeenCalledTimes(1);
  expect(logger.warn).toHaveBeenCalledWith(
    "Config warnings: plugins.entries.google-antigravity-auth: plugin removed: google-antigravity-auth (stale config entry ignored; remove it from plugins config)",
  );

  createConfigIO({ ...options, pluginValidation: "skip" }).loadConfig();
  load();
  expect(logger.warn).toHaveBeenCalledTimes(1);

  await write({ ...removed("google-antigravity-auth"), gateway: { port: "invalid" } });
  expect(load).toThrow();
  await checkWarning("google-antigravity-auth", 1);

  await checkWarning("google-gemini-cli-auth", 2);

  await write({});
  load();
  await checkWarning("google-gemini-cli-auth", 3);

  await write(null);
  expect(load).toThrow(expect.objectContaining({ code: "INVALID_CONFIG" }));
  expect(await io.readConfigFileSnapshot()).toMatchObject({ exists: true, valid: false });
  await checkWarning("google-gemini-cli-auth", 3);
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
      `Your OpenClaw config was written by version 9999.1.1, but this command is running ${VERSION}.\nCheck: \`openclaw --version\`, \`which openclaw\`, and \`openclaw gateway status --deep\`.\nIf unexpected, update PATH so \`openclaw\` points to the version you want, or reinstall the Gateway service from that same OpenClaw install.`,
    );
  }
});

it("normalizes safe-bin config entries at config load time", () => {
  const globalExec = {
    safeBinTrustedDirs: [" /custom/bin ", "", "/custom/bin", "/agent/bin"],
    safeBinProfiles: { " MyFilter ": { allowedValueFlags: ["--limit", " --limit ", ""] } },
  };
  const agentExec = {
    safeBinTrustedDirs: [" /ops/bin ", "/ops/bin"],
    safeBinProfiles: { " Custom ": { deniedFlags: ["-f", " -f ", ""] } },
  };
  const cfg = {
    tools: { exec: globalExec },
    agents: { entries: { ops: { tools: { exec: agentExec } } } },
  };
  normalizeExecSafeBinProfilesInConfig(cfg);
  expect(cfg.tools.exec).toEqual({
    safeBinProfiles: { myfilter: { allowedValueFlags: ["--limit"] } },
    safeBinTrustedDirs: ["/custom/bin", "/agent/bin"],
  });
  expect(cfg.agents.entries.ops.tools.exec).toEqual({
    safeBinProfiles: { custom: { deniedFlags: ["-f"] } },
    safeBinTrustedDirs: ["/ops/bin"],
  });
});
