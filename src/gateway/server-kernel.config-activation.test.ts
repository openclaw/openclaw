import fs from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { expect, it, vi } from "vitest";
import {
  getConfigOverrides,
  resetConfigOverrides,
  setConfigOverride,
} from "../config/runtime-overrides.js";
import {
  getRuntimeConfigSnapshot,
  getRuntimeConfigSourceSnapshot,
} from "../config/runtime-snapshot.js";
import * as runtimeSnapshots from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { closeKernelFixture, createKernelFixture } from "./server-kernel.fixture-test-support.js";
import { createGatewayKernel } from "./server-kernel.js";

function expectDeepEqual(actual: unknown, expected: unknown) {
  expect(isDeepStrictEqual(actual, expected)).toBe(true);
}

it.each(["explicit token", "auth none", "generated token", "tailscale only"] as const)(
  "createGatewayKernel prepares source activation with captured runtime and %s startup overrides",
  async (mode) => {
    const fixture = await createKernelFixture("gateway-kernel-reload-candidate", {
      env: {
        OPENCLAW_TEST_MINIMAL_GATEWAY: "0",
        OPENCLAW_SKIP_CHANNELS: undefined,
        OPENCLAW_SKIP_PROVIDERS: undefined,
      },
    });
    const { port, state } = fixture;
    const previousOverrides = getConfigOverrides();
    const sourceToken = "gateway-reload-source-token";
    const startupToken = "gateway-reload-startup-token";
    const sourceAuth =
      mode === "explicit token"
        ? { mode: "token" as const, token: sourceToken, rateLimit: { maxAttempts: 3 } }
        : mode === "generated token"
          ? undefined
          : { mode: "none" as const };
    const startupAuth =
      mode === "explicit token"
        ? { mode: "token" as const, token: startupToken, rateLimit: { maxAttempts: 7 } }
        : mode === "auth none"
          ? { mode: "none" as const }
          : undefined;
    let kernel: Awaited<ReturnType<typeof createGatewayKernel>> | undefined;
    const beforePublication = new Map<
      OpenClawConfig,
      { runtime: OpenClawConfig | null; source: OpenClawConfig | null }
    >();
    const publish = runtimeSnapshots.setAppliedRuntimeConfigSnapshot;
    using _ = vi
      .spyOn(runtimeSnapshots, "setAppliedRuntimeConfigSnapshot")
      .mockImplementation(async (config, source) => {
        beforePublication.set(config, {
          runtime: getRuntimeConfigSnapshot(),
          source: getRuntimeConfigSourceSnapshot(),
        });
        await publish(config, source);
      });
    try {
      resetConfigOverrides();
      await fixture.configure({
        agents: { defaults: { workspace: state.workspaceDir } },
        gateway: { auth: sourceAuth, controlUi: { enabled: false }, port },
        logging: { level: "silent", consoleLevel: "silent" },
        messages: { visibleReplies: "automatic" },
        plugins: { allow: [] },
      });
      kernel = await fixture.open({
        auth: startupAuth,
        ...(mode === "tailscale only" ? { tailscale: { mode: "off" } } : {}),
      });
      expect(kernel.minimalTestGateway).toBe(false);
      expect(kernel.generatedStartupAuthToken).toBe(mode === "generated token");
      expect(kernel.gatewayPluginConfigAtStart).not.toBe(kernel.cfgAtStart);
      expect(kernel.gatewayPluginConfigAtStart).toEqual(kernel.cfgAtStart);
      const previous = beforePublication.get(kernel.gatewayPluginConfigAtStart);
      expect(getRuntimeConfigSnapshot()).toBe(previous?.runtime);
      expect(getRuntimeConfigSourceSnapshot()).toBe(previous?.source);
      expect(getRuntimeConfigSnapshot()).toEqual(kernel.gatewayPluginConfigAtStart);
      expect(getRuntimeConfigSourceSnapshot()).toEqual(kernel.configSnapshot.sourceConfig);
      if (startupAuth?.mode === "token") {
        startupAuth.token = "mutated-caller-token";
        startupAuth.rateLimit.maxAttempts = 99;
      }
      expect(setConfigOverride("messages.visibleReplies", "message_tool").ok).toBe(true);
      expect(setConfigOverride("gateway.port", port).ok).toBe(true);
      const previousSourceConfig = kernel.configSnapshot.sourceConfig;
      const sourcePort = (port % 65_535) + 1;
      const sourceConfig = {
        ...previousSourceConfig,
        gateway: { ...previousSourceConfig.gateway, port: sourcePort },
        channels: {
          ...previousSourceConfig.channels,
          telegram: { botToken: "source-bot-token" },
        },
        logging: { ...previousSourceConfig.logging, level: "debug" },
      } satisfies OpenClawConfig;
      const originalSource = structuredClone(sourceConfig);
      const runtimeConfig = {
        ...sourceConfig,
        channels: { ...sourceConfig.channels, telegram: { botToken: "materialized-bot-token" } },
        logging: { ...sourceConfig.logging, consoleLevel: "error" },
      } satisfies OpenClawConfig;
      const persistedBefore = await fs.readFile(state.configPath, "utf8");
      const candidate = await kernel.prepareReloadCandidate({
        runtimeConfig,
        sourceConfig,
        previousSourceConfig,
      });
      expect(candidate.compareConfig).toMatchObject({
        channels: { telegram: { enabled: true, botToken: "source-bot-token" } },
        logging: { level: "debug", consoleLevel: "silent" },
        messages: { visibleReplies: "message_tool" },
        gateway: { port },
      });
      expectDeepEqual(candidate.compareConfig.gateway?.auth, sourceAuth);
      expect(candidate.runtimeConfig).toMatchObject({
        channels: { telegram: { enabled: true, botToken: "materialized-bot-token" } },
        logging: { level: "debug", consoleLevel: "error" },
        messages: { visibleReplies: "message_tool" },
      });
      if (mode === "explicit token") {
        expect(candidate.runtimeConfig.gateway?.auth?.token === startupToken).toBe(true);
        expect(candidate.runtimeConfig.gateway?.auth?.rateLimit).toEqual({ maxAttempts: 7 });
      }
      expect(sourceConfig.gateway.port).toBe(sourcePort);
      // Strict equality also checks the gateway and auth property sets.
      expectDeepEqual(candidate.runtimeConfig.gateway, kernel.cfgAtStart.gateway);
      expect(candidate.runtimeEnv.env).toMatchObject({
        OPENCLAW_STATE_DIR: state.stateDir,
        OPENCLAW_CONFIG_PATH: state.configPath,
      });
      expect(setConfigOverride("messages.visibleReplies", "automatic").ok).toBe(true);
      expectDeepEqual(candidate.reapplyRuntimeOverlays(runtimeConfig), candidate.runtimeConfig);
      expectDeepEqual(candidate.reapplyCompareOverlays(sourceConfig), candidate.compareConfig);
      expectDeepEqual(sourceConfig, originalSource);
      expect((await fs.readFile(state.configPath, "utf8")) === persistedBefore).toBe(true);
      if (mode === "generated token") {
        const explicitSourceConfig = {
          ...sourceConfig,
          gateway: { ...sourceConfig.gateway, auth: { mode: "none" as const } },
        };
        const explicitCandidate = await kernel.prepareReloadCandidate({
          runtimeConfig: explicitSourceConfig,
          sourceConfig: explicitSourceConfig,
          previousSourceConfig,
        });
        expect(explicitCandidate.runtimeConfig.gateway?.auth?.mode).toBe("none");
        expect(
          explicitCandidate.runtimeConfig.gateway?.auth?.token ===
            kernel.cfgAtStart.gateway?.auth?.token,
        ).toBe(true);
      }
    } finally {
      await closeKernelFixture(kernel, state, () => {
        resetConfigOverrides();
        for (const [key, value] of Object.entries(previousOverrides)) {
          setConfigOverride(key, value);
        }
      });
    }
  },
);
