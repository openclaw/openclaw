import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  cleanupPluginLoaderFixturesForTest,
  makePluginLoaderTempDir,
  resetPluginLoaderTestStateForTest,
  useNoBundledPlugins,
  writePluginMetadata,
} from "../plugins/loader.test-fixtures.js";
import { withEnvAsync } from "../test-utils/env.js";
import { channelsStatusCommand } from "./channels/status.js";
import { createCapturingTestRuntime } from "./test-runtime-config-helpers.js";

const mocks = vi.hoisted(() => ({
  callGateway: vi.fn(),
  requireValidConfigFileSnapshot: vi.fn(),
  resolveCommandConfigWithSecrets: vi.fn(),
}));

// mock-isolation: Force the offline status path without contacting a live Gateway.
vi.mock("../gateway/call.js", () => ({ callGateway: mocks.callGateway }));

vi.mock("./config-validation.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./config-validation.js")>()),
  requireValidConfigFileSnapshot: mocks.requireValidConfigFileSnapshot,
}));

// mock-isolation: Resolve only the synthetic external-plugin config and credentials.
vi.mock("../cli/command-config-resolution.js", () => ({
  resolveCommandConfigWithSecrets: mocks.resolveCommandConfigWithSecrets,
}));

// mock-isolation: JSON fallback proof does not need account rendering or runtime channel state.
vi.mock("./channels/shared.js", () => ({
  appendBaseUrlBit: () => undefined,
  appendEnabledConfiguredLinkedBits: () => undefined,
  appendModeBit: () => undefined,
  appendTokenSourceBits: () => undefined,
  buildChannelAccountLine: () => "",
}));

vi.mock("../cli/progress.js", () => ({
  withProgress: async (_opts: unknown, run: () => Promise<unknown>) => await run(),
}));

function writeExternalEnvChannelPlugin() {
  useNoBundledPlugins();
  const pluginDir = makePluginLoaderTempDir();
  const fullMarker = path.join(pluginDir, "full-loaded.txt");
  writePluginMetadata({
    dir: pluginDir,
    id: "external-env-channel-plugin",
    channels: ["external-env-channel"],
    packageJson: {
      name: "@example/openclaw-external-env-channel",
      version: "1.0.0",
      openclaw: {
        extensions: ["./index.cjs"],
        channel: {
          id: "external-env-channel",
          configuredState: { env: { anyOf: ["EXTERNAL_ENV_CHANNEL_TOKEN"] } },
        },
      },
    },
  });
  fs.writeFileSync(
    path.join(pluginDir, "index.cjs"),
    `require("node:fs").writeFileSync(${JSON.stringify(fullMarker)}, "loaded", "utf-8");`,
    "utf-8",
  );
  return { pluginDir, fullMarker };
}

afterEach(resetPluginLoaderTestStateForTest);

it("reports env-only external manifest channels in JSON fallback without full runtime load", async () => {
  Object.values(mocks).forEach((mock) => mock.mockReset());
  mocks.callGateway.mockRejectedValue(new Error("gateway closed"));
  const { pluginDir, fullMarker } = writeExternalEnvChannelPlugin();
  const config: OpenClawConfig = {
    plugins: { load: { paths: [pluginDir] }, allow: ["external-env-channel-plugin"] },
  };
  mocks.requireValidConfigFileSnapshot.mockResolvedValue({ path: "/tmp/openclaw.json", config });
  mocks.resolveCommandConfigWithSecrets.mockResolvedValue({
    resolvedConfig: config,
    effectiveConfig: config,
    diagnostics: [],
  });
  const { runtime, logs } = createCapturingTestRuntime();

  await withEnvAsync({ EXTERNAL_ENV_CHANNEL_TOKEN: "token" }, async () => {
    await channelsStatusCommand({ json: true, probe: false }, runtime as never);
  });

  expect(fs.existsSync(fullMarker)).toBe(false);
  expect(JSON.parse(logs.at(-1) ?? "{}")).toMatchObject({
    gatewayReachable: false,
    configOnly: true,
    configuredChannels: ["external-env-channel"],
  });
});

afterAll(cleanupPluginLoaderFixturesForTest);
