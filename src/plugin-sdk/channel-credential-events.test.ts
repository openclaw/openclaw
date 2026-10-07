import { afterEach, describe, expect, it, vi } from "vitest";
import {
  runChannelAccountMonitor,
  runChannelAccountStartup,
} from "../gateway/server-channel-startup.js";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../plugins/hook-runner-global.js";
import * as hookRunnerGlobal from "../plugins/hook-runner-global.js";
import { createMockPluginRegistry } from "../plugins/hooks.test-helpers.js";
import { PluginInstance } from "../plugins/plugin-instance.js";
import { markPluginRegistryRetired } from "../plugins/registry-lifecycle.js";
import { withPluginRuntimeRegistryScope } from "../plugins/runtime/gateway-request-scope.js";
import { withPluginRuntimeGenerationRegistryScope } from "../plugins/runtime/generation-state.js";
import type { OpenClawPluginApi } from "../plugins/types.js";
import {
  assertChannelTokensRevokedConsumersReady,
  dispatchChannelTokensRevoked,
  registerChannelTokensRevokedConsumer,
} from "./channel-credential-events.js";

const event = {
  eventId: "EvREVOCATION1",
  eventTime: 1_700_000_000,
  appId: "A123",
  workspaceId: "T123",
  oauthUserIds: ["U123"],
};
const context = { channelId: "slack", accountId: "default" };
const policy = { requiredConsumerPluginIds: ["required"] };
afterEach(resetGlobalHookRunner);

describe("channel credential event SDK", () => {
  it("preserves stock no-runner behavior but fails closed when a consumer is required", async () => {
    resetGlobalHookRunner();
    await expect(assertChannelTokensRevokedConsumersReady()).resolves.toBeUndefined();
    await expect(dispatchChannelTokensRevoked(event, context)).resolves.toBeUndefined();
    await expect(assertChannelTokensRevokedConsumersReady(policy)).rejects.toThrow(
      "required consumer is unavailable",
    );
    await expect(dispatchChannelTokensRevoked(event, context, policy)).rejects.toThrow(
      "required consumer is unavailable",
    );
  });

  it("rechecks replacement registries after readiness and resumes against the new handler", async () => {
    const oldHandler = vi.fn();
    const nextHandler = vi.fn();
    const createRegistry = (handler: typeof oldHandler) =>
      createMockPluginRegistry([
        { pluginId: "required", hookName: "channel_tokens_revoked", handler },
      ]);
    initializeGlobalHookRunner(createRegistry(oldHandler));
    await assertChannelTokensRevokedConsumersReady(policy);
    initializeGlobalHookRunner(createMockPluginRegistry([]));
    await expect(dispatchChannelTokensRevoked(event, context, policy)).rejects.toThrow(
      "required consumer is unavailable",
    );
    initializeGlobalHookRunner(createRegistry(nextHandler));
    await dispatchChannelTokensRevoked(event, context, policy);
    expect(oldHandler).not.toHaveBeenCalled();
    expect(nextHandler).toHaveBeenCalledWith(event, context);
  });

  it("registers only through the supplied lifecycle-bound API", () => {
    const on = vi.fn<OpenClawPluginApi["on"]>();
    const handler = vi.fn();
    registerChannelTokensRevokedConsumer({ on }, handler);
    expect(on).toHaveBeenCalledExactlyOnceWith("channel_tokens_revoked", handler);
  });

  it.each([
    ["generation", "readiness"],
    ["generation", "dispatch"],
    ["request", "readiness"],
    ["request", "dispatch"],
  ] as const)(
    "rejects required %s-scope %s retired during runner resolution",
    async (kind, operation) => {
      const oldHandler = vi.fn();
      const replacementHandler = vi.fn();
      const captured = createMockPluginRegistry([
        { pluginId: "required", hookName: "channel_tokens_revoked", handler: oldHandler },
      ]);
      const replacement = createMockPluginRegistry([
        { pluginId: "required", hookName: "channel_tokens_revoked", handler: replacementHandler },
      ]);
      initializeGlobalHookRunner(captured);
      const runner = hookRunnerGlobal.getGlobalHookRunner();
      const resolve = vi
        .spyOn(hookRunnerGlobal, "getGlobalHookRunner")
        .mockImplementationOnce(() => {
          markPluginRegistryRetired(captured);
          initializeGlobalHookRunner(replacement);
          return runner;
        });
      const inCapturedScope = <T>(run: () => T) =>
        kind === "generation"
          ? withPluginRuntimeGenerationRegistryScope(captured, run)
          : withPluginRuntimeRegistryScope(captured, run);
      try {
        await inCapturedScope(() => {
          const result =
            operation === "readiness"
              ? assertChannelTokensRevokedConsumersReady(policy)
              : dispatchChannelTokensRevoked(event, context, policy);
          return expect(result).rejects.toThrow("required consumer is unavailable");
        });
        expect(resolve).toHaveBeenCalledTimes(1);
        expect(oldHandler).not.toHaveBeenCalled();
        expect(replacementHandler).not.toHaveBeenCalled();
      } finally {
        resolve.mockRestore();
      }
    },
  );

  it.each(["generation", "request"] as const)(
    "rejects a retired consumer in a captured %s scope and reaches its replacement through channel startup ownership",
    async (kind) => {
      const oldHandler = vi.fn();
      const nextHandler = vi.fn();
      const captured = createMockPluginRegistry([
        { pluginId: "required", hookName: "channel_tokens_revoked", handler: oldHandler },
      ]);
      const replacement = createMockPluginRegistry([
        { pluginId: "required", hookName: "channel_tokens_revoked", handler: nextHandler },
        { pluginId: "slack", hookName: "message_received", handler: vi.fn() },
      ]);
      const [oldRecord] = captured.plugins;
      const [nextRecord, sourceRecord] = replacement.plugins;
      const [oldHook] = captured.typedHooks;
      const [nextHook] = replacement.typedHooks;
      if (!oldRecord || !nextRecord || !sourceRecord || !oldHook || !nextHook) {
        throw new Error("Expected the captured/replacement plugin records and consumer hooks");
      }
      const oldInstance = new PluginInstance("required", {
        record: oldRecord,
        registry: captured,
      });
      const nextInstance = new PluginInstance("required", {
        record: nextRecord,
        registry: replacement,
      });
      const sourceInstance = new PluginInstance("slack", {
        record: sourceRecord,
        registry: replacement,
      });
      oldHook.handler = oldInstance.wrap(oldHandler);
      nextHook.handler = nextInstance.wrap(nextHandler);
      const inCapturedScope = <T>(run: () => T) =>
        kind === "generation"
          ? withPluginRuntimeGenerationRegistryScope(captured, run)
          : withPluginRuntimeRegistryScope(captured, run);
      initializeGlobalHookRunner(captured);
      try {
        await inCapturedScope(async () => {
          await assertChannelTokensRevokedConsumersReady(policy);
          markPluginRegistryRetired(captured);
          initializeGlobalHookRunner(replacement);
          await expect(dispatchChannelTokensRevoked(event, context, policy)).rejects.toThrow(
            "required consumer is unavailable",
          );
          expect(oldHandler).not.toHaveBeenCalled();
          expect(nextHandler).not.toHaveBeenCalled();
          // This is the existing Gateway source owner, not a dispatcher fallback
          // from a retired generation to the process-global registry.
          await runChannelAccountStartup(() =>
            runChannelAccountMonitor(replacement, "slack", () =>
              dispatchChannelTokensRevoked(event, context, policy),
            ),
          );
          expect(nextHandler).toHaveBeenCalledExactlyOnceWith(event, context);
          // The caller retains its original selection; only fresh channel work
          // obtains replacement admission.
          await expect(dispatchChannelTokensRevoked(event, context, policy)).rejects.toThrow(
            "required consumer is unavailable",
          );
        });
      } finally {
        await Promise.all([
          oldInstance.dispose(),
          nextInstance.dispose(),
          sourceInstance.dispose(),
        ]);
      }
    },
  );
});
