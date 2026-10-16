import fs from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { describe, expect, it, vi } from "vitest";
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
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { getFreePort } from "../test-utils/ports.js";
import { createGatewayKernel } from "./server-kernel.js";
import { KERNEL_TEST_ENV } from "./test-helpers.env.js";

describe("createGatewayKernel", () => {
  it.each(["explicit token", "auth none", "generated token", "tailscale only"] as const)(
    "prepares source activation with captured runtime and %s startup overrides",
    async (mode) => {
      const port = await getFreePort();
      const state = await createOpenClawTestState({
        label: "gateway-kernel-reload-candidate",
        env: {
          ...KERNEL_TEST_ENV,
          OPENCLAW_TEST_MINIMAL_GATEWAY: "0",
          OPENCLAW_SKIP_CHANNELS: undefined,
          OPENCLAW_SKIP_PROVIDERS: undefined,
        },
      });
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
        await state.writeConfig({
          agents: { defaults: { workspace: state.workspaceDir } },
          gateway: { auth: sourceAuth, controlUi: { enabled: false }, port },
          logging: { level: "silent", consoleLevel: "silent" },
          messages: { visibleReplies: "automatic" },
          plugins: { allow: [] },
        });
        state.applyEnv();
        kernel = await createGatewayKernel(port, {
          auth: startupAuth,
          ...(mode === "tailscale only" ? { tailscale: { mode: "off" } } : {}),
          bind: "loopback",
          controlUiEnabled: false,
          sidecarStartup: "defer",
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
        expect(candidate.compareConfig.channels).toMatchObject({
          telegram: { enabled: true, botToken: "source-bot-token" },
        });
        expect(isDeepStrictEqual(candidate.compareConfig.gateway?.auth, sourceAuth)).toBe(true);
        expect(candidate.compareConfig.logging).toMatchObject({
          level: "debug",
          consoleLevel: "silent",
        });
        expect(candidate.compareConfig.messages).toMatchObject({ visibleReplies: "message_tool" });
        expect(candidate.runtimeConfig.channels).toMatchObject({
          telegram: { enabled: true, botToken: "materialized-bot-token" },
        });
        if (mode === "explicit token") {
          expect(candidate.runtimeConfig.gateway?.auth?.token === startupToken).toBe(true);
          expect(candidate.runtimeConfig.gateway?.auth?.rateLimit).toEqual({ maxAttempts: 7 });
        }
        expect(candidate.runtimeConfig.logging).toMatchObject({
          level: "debug",
          consoleLevel: "error",
        });
        expect(candidate.runtimeConfig.messages).toMatchObject({ visibleReplies: "message_tool" });
        expect(candidate.compareConfig.gateway?.port).toBe(port);
        expect(sourceConfig.gateway.port).toBe(sourcePort);
        expect(Object.keys(candidate.runtimeConfig.gateway ?? {}).toSorted()).toEqual(
          Object.keys(kernel.cfgAtStart.gateway ?? {}).toSorted(),
        );
        expect(Object.keys(candidate.runtimeConfig.gateway?.auth ?? {}).toSorted()).toEqual(
          Object.keys(kernel.cfgAtStart.gateway?.auth ?? {}).toSorted(),
        );
        expect(isDeepStrictEqual(candidate.runtimeConfig.gateway, kernel.cfgAtStart.gateway)).toBe(
          true,
        );
        expect(candidate.runtimeEnv.env.OPENCLAW_STATE_DIR).toBe(state.stateDir);
        expect(candidate.runtimeEnv.env.OPENCLAW_CONFIG_PATH).toBe(state.configPath);
        expect(setConfigOverride("messages.visibleReplies", "automatic").ok).toBe(true);
        expect(
          isDeepStrictEqual(
            candidate.reapplyRuntimeOverlays(runtimeConfig),
            candidate.runtimeConfig,
          ),
        ).toBe(true);
        expect(
          isDeepStrictEqual(
            candidate.reapplyCompareOverlays(sourceConfig),
            candidate.compareConfig,
          ),
        ).toBe(true);
        expect(isDeepStrictEqual(sourceConfig, originalSource)).toBe(true);
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
        try {
          await kernel?.closeOnStartupFailure();
        } finally {
          resetConfigOverrides();
          for (const [key, value] of Object.entries(previousOverrides)) {
            setConfigOverride(key, value);
          }
          await state.cleanup();
        }
      }
    },
  );
});
