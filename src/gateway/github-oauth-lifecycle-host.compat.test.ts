import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import { readRepositoryServices } from "../../extensions/github-repositories/account-runtime-api.js";
import repositoryPlugin from "../../extensions/github-repositories/index.js";
import repositoryManifest from "../../extensions/github-repositories/openclaw.plugin.json" with { type: "json" };
import { captureRuntimeConfigAsyncReader } from "../config/config.js";
import { installNativeGitHubLegacyOAuthLookup } from "../plugin-sdk/native-github-account-host.js";
import {
  createPluginRegistryFixture,
  registerTestPlugin,
} from "../plugin-sdk/plugin-test-contracts.js";
import { getPluginInstance } from "../plugins/plugin-instance-scope.js";
import { withPluginRuntimeGatewayContextResolver } from "../plugins/runtime/gateway-request-scope.js";
import { startPluginServices, type PluginServicesHandle } from "../plugins/services.js";
import { createPluginRecord } from "../plugins/status.test-helpers.js";
import { updateUserGitHubConnection } from "../state/user-github-connections.test-support.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createRepositorySessionReadHost } from "./control-ui-session-pr-runtime.js";
import { createGatewayRequestContext } from "./server-request-context.js";
import { makeContextParams } from "./server-request-context.test-support.js";

it("keeps the production legacy lookup absent without an admitted managed service", async () => {
  const params = makeContextParams();
  const context = createGatewayRequestContext(params);
  context.resolveGatewayContext = () => context;
  const read = vi.fn(() => undefined);
  try {
    expect(context.githubOAuthService).toBeUndefined();
    await expect(
      withPluginRuntimeGatewayContextResolver(context.resolveGatewayContext, () =>
        installNativeGitHubLegacyOAuthLookup(read, new AbortController().signal),
      ),
    ).rejects.toThrow("requires its live Gateway plugin service");
    expect(read).not.toHaveBeenCalled();
    expect(context.githubOAuthService).toBeUndefined();
  } finally {
    await params.runtime.scheduler.stop();
  }
});

it("projects only each Gateway's real account owner and retires captured sync callbacks", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    await captureRuntimeConfigAsyncReader()();
    const gateways = Array.from({ length: 2 }, () => {
      const params = makeContextParams();
      const context = createGatewayRequestContext(params);
      const resolveGatewayContext = () => context;
      context.resolveGatewayContext = resolveGatewayContext;
      const scheduler = params.runtime.scheduler;
      params.runtime.runtimeState.repositorySessions = createRepositorySessionReadHost({
        signal: scheduler.signal,
        getRuntimeConfig: context.getRuntimeConfig,
        getSessionRowProjection: params.runtime.getSessionRowProjection,
        getClient: () => undefined,
        resolveGatewayContext,
        broadcastToConnIds: params.runtime.broadcastToConnIds,
      });
      return { context, scheduler };
    });
    const cleanup: Array<() => Promise<void>> = [];
    try {
      const started = [];
      for (const gateway of gateways) {
        expect(gateway.context.githubOAuthService).toBeUndefined();
        const fixture = createPluginRegistryFixture(gateway.context.getRuntimeConfig());
        const record = createPluginRecord({
          id: repositoryManifest.id,
          name: repositoryManifest.name,
          repositorySources: repositoryManifest.repositorySources,
          contracts: repositoryManifest.contracts,
          dashboard: repositoryManifest.dashboard,
        });
        registerTestPlugin({ ...fixture, record, register: repositoryPlugin.register });
        const instance = getPluginInstance(record);
        assert(instance, "Expected the actual managed GitHub instance");
        let services: PluginServicesHandle | undefined;
        const close = async () => {
          await services?.stop({ strict: true });
          await instance.dispose();
        };
        cleanup.push(close);
        // Each Gateway starts its own actual registry; process publication would retire its sibling.
        await withPluginRuntimeGatewayContextResolver(gateway.context.resolveGatewayContext, () =>
          startPluginServices({
            scheduler: gateway.scheduler,
            registry: fixture.registry.registry,
            config: fixture.config,
            throwOnStartError: true,
            onHandle: (handle) => {
              services = handle;
            },
          }),
        );
        const projected = gateway.context.githubOAuthService;
        assert(projected, "Expected the production getter to select the installed plugin");
        expect(gateway.context.githubOAuthService).toBe(projected);
        expect(
          projected.cancelAuthorization("github-device-00000000000000000000000000000001"),
        ).toBe(false);
        started.push({ ...gateway, projected, close });
      }
      const [first, second] = started;
      assert(first && second);
      expect(first.projected).not.toBe(second.projected);
      const owner = ensureProfileForEmail("legacy-account-projection@example.invalid").id;
      const action = { owner, assertCurrent: () => {} };
      const status = await second.projected.personal.status(action);
      const canonical = readRepositoryServices(second.context)?.oauth;
      assert(canonical);
      expect(canonical.personal.revalidateStatus(action, status)).toBe(status);
      updateUserGitHubConnection(
        owner,
        () => ({ version: 1, generation: randomUUID(), selection: { kind: "disconnected" } }),
        action.assertCurrent,
      );
      // The ordinary DTO must remain the real plugin WeakMap key, including its retained guard.
      expect(() => second.projected.personal.revalidateStatus(action, status)).toThrow(
        "My GitHub connection changed",
      );
      const cancel = first.projected.cancelAuthorization.bind(first.projected);
      const cancelPersonal = first.projected.personal.cancelAuthorization.bind(
        first.projected.personal,
      );
      expect(cancelPersonal(action, "00000000-0000-4000-8000-000000000001")).toBe(false);
      await first.close();
      expect(first.context.githubOAuthService).toBeUndefined();
      expect(() => cancel("github-device-00000000000000000000000000000001")).toThrow();
      expect(() => cancelPersonal(action, "00000000-0000-4000-8000-000000000001")).toThrow();
      expect(second.context.githubOAuthService).toBe(second.projected);
      expect(
        second.projected.cancelAuthorization("github-device-00000000000000000000000000000001"),
      ).toBe(false);
    } finally {
      for (const close of cleanup.toReversed()) {
        await close();
      }
      for (const gateway of gateways) {
        await gateway.scheduler.stop();
      }
    }
  });
});
