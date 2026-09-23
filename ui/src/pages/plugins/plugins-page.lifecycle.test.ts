/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred as deferred } from "../../../../test/helpers/promise.js";
import { GatewayRequestError } from "../../api/gateway.ts";
import { showConfirmDialog } from "../../components/confirm-dialog.ts";
import { i18n } from "../../i18n/index.ts";
import type {
  PluginInstallRequest,
  PluginListResult,
  PluginMutationResult,
} from "../../lib/plugins/index.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import {
  createClient,
  createContext,
  createDiscoveryDetail,
  createGateway,
  createInspectResult,
  createPlugin,
  createPluginsRouteData,
  createPluginsRouteLocation,
  createResult,
  createRuntimeConfigHarness,
  mountPage,
  resetPluginsPageTestState,
} from "./plugins-page.test-support.ts";

vi.mock("../../components/confirm-dialog.ts", () => ({ showConfirmDialog: vi.fn() }));

describe("PluginsPage lifecycle confirmation", () => {
  beforeEach(async () => {
    await i18n.setLocale("en");
    vi.mocked(showConfirmDialog).mockReset().mockResolvedValue(true);
  });

  afterEach(resetPluginsPageTestState);

  function createQueuedRuntimeConfig(client: ReturnType<typeof createClient>["client"]) {
    const queued = deferred();
    const release = deferred();
    const harness = createRuntimeConfigHarness(
      vi.fn(async () => undefined),
      { configFormDirty: false, lastError: null },
      () => client,
    );
    harness.runtimeConfig.runExternalMutation = async (task, options) => {
      queued.resolve();
      await release.promise;
      if (options?.canDispatch && !options.canDispatch()) {
        return {
          ok: false,
          reason: "unavailable",
          error: options.dispatchError ?? "Mutation scope changed before dispatch.",
        };
      }
      return { ok: true, value: await task(client), refresh: { ok: true } };
    };
    return { harness, queued: queued.promise, release };
  }

  it.each([{ warnings: [] }, { warnings: ["A plugin service needs attention."] }])(
    "installs directly and records installed controls while preserving warnings %j",
    async ({ warnings }) => {
      const offered = createPlugin({
        id: "calendar",
        name: "Calendar",
        packageName: "calendar",
        installed: false,
        enabled: false,
        state: "not-installed",
        removable: true,
      });
      const detail = createDiscoveryDetail(offered);
      detail.plugin.id = "ch_Y2FsZW5kYXI";
      const committed = {
        ...offered,
        installed: true,
        enabled: false,
        state: "disabled" as const,
        catalogId: detail.plugin.id,
      };
      const installing = deferred<PluginMutationResult>();
      const { client, request } = createClient(async (method) => {
        if (method === "plugins.catalog.get") {
          return detail;
        }
        if (method === "plugins.install") {
          return installing.promise;
        }
        if (method === "plugins.list") {
          return createResult(committed);
        }
        if (method === "plugins.inspect") {
          return createInspectResult({ plugin: committed });
        }
        throw new Error(`Unexpected method ${method}`);
      });
      const harness = createGateway(client);
      const { page } = await mountPage(
        createContext(harness.gateway),
        createPluginsRouteData(
          harness.gateway,
          createResult(offered),
          createPluginsRouteLocation(`/plugins/${detail.plugin.id}`),
        ),
      );
      await waitForFast(() =>
        expect(page.querySelector(".plugin-catalog-detail__install")).not.toBeNull(),
      );
      page.querySelector<HTMLButtonElement>(".plugin-catalog-detail__install")!.click();
      await waitForFast(() =>
        expect(request).toHaveBeenCalledWith(
          "plugins.install",
          {
            source: "clawhub",
            packageName: "calendar",
          },
          expect.objectContaining({ onSent: expect.any(Function) }),
        ),
      );
      expect(showConfirmDialog).not.toHaveBeenCalled();
      expect(page.querySelector("openclaw-modal-dialog")).toBeNull();
      expect(
        page.querySelector<HTMLButtonElement>(".plugin-catalog-detail__install")?.disabled,
      ).toBe(false);
      page.querySelector<HTMLButtonElement>(".plugin-catalog-detail__install")!.click();
      expect(request.mock.calls.filter(([method]) => method === "plugins.install")).toHaveLength(1);
      installing.resolve({ ok: true, plugin: committed, restartRequired: false, warnings });
      await waitForFast(() =>
        expect(page.querySelector('[aria-label="Enable Calendar"]')).not.toBeNull(),
      );
      expect(page.textContent).not.toContain("Installed Calendar.");
      expect(page.messages["plugin:calendar"]).toEqual(
        warnings.length ? { kind: "warning", text: warnings.join("\n") } : undefined,
      );
      expect(request.mock.calls.some(([method]) => method === "plugins.setEnabled")).toBe(false);
      expect(
        [
          ...page.querySelectorAll(
            ".plugin-catalog-detail__actions button, .plugin-catalog-detail__actions a",
          ),
        ].map((element) => element.getAttribute("aria-label")),
      ).toEqual(["Enable Calendar", "Uninstall Calendar", "Settings"]);
    },
  );

  it("does not uninstall on a replacement Gateway after confirmation started", async () => {
    const removable = createPlugin({
      id: "community-thing",
      name: "Community Thing",
      origin: "global",
      removable: true,
      featured: false,
    });
    const result = {
      plugins: [createPlugin(), removable],
      diagnostics: [],
      mutationAllowed: true,
    } satisfies PluginListResult;
    const { client: initialClient, request: initialRequest } = createClient(async () => {
      throw new Error("The initial Gateway must not receive a request while confirmation is open.");
    });
    const { client: replacementClient, request: replacementRequest } = createClient(
      async (method) => {
        if (method === "plugins.list") {
          return result;
        }
        if (method === "plugins.uninstall") {
          return {
            ok: true,
            pluginId: "community-thing",
            restartRequired: true,
            removed: ["install record"],
          };
        }
        throw new Error(`Unexpected replacement method ${method}`);
      },
    );
    const harness = createGateway(initialClient);
    const { page } = await mountPage(
      createContext(harness.gateway),
      createPluginsRouteData(harness.gateway, result),
    );
    const confirmation = deferred<boolean>();
    vi.mocked(showConfirmDialog).mockReturnValueOnce(confirmation.promise);

    const uninstall = page.uninstall("community-thing", "plugin:community-thing");
    await waitForFast(() => expect(showConfirmDialog).toHaveBeenCalledOnce());
    harness.emit(replacementClient, true);
    confirmation.resolve(true);
    await uninstall;

    expect(initialRequest).not.toHaveBeenCalledWith("plugins.uninstall", {
      pluginId: "community-thing",
    });
    expect(replacementRequest).not.toHaveBeenCalledWith("plugins.uninstall", {
      pluginId: "community-thing",
    });
  });

  it("does not install after its confirmed Gateway source changes while config writes drain", async () => {
    const available = createPlugin({
      id: "community-thing",
      name: "Community Thing",
      origin: "global",
      installed: false,
      enabled: false,
      state: "not-installed",
      install: { source: "official", pluginId: "community-thing" },
    });
    const { client, request: gatewayRequest } = createClient(async (method) => {
      if (method === "plugins.install") {
        return {
          ok: true,
          plugin: { ...available, installed: true },
          restartRequired: true,
        } satisfies PluginMutationResult;
      }
      throw new Error(`Unexpected method ${method}`);
    });
    const initialGateway = createGateway(client);
    const replacementGateway = createGateway(client);
    const config = createQueuedRuntimeConfig(client);
    const initialContext = createContext(
      initialGateway.gateway,
      undefined,
      undefined,
      config.harness,
    );
    const { page, provider } = await mountPage(
      initialContext,
      createPluginsRouteData(initialGateway.gateway, createResult(available)),
    );
    const request = {
      source: "official",
      pluginId: "community-thing",
    } satisfies PluginInstallRequest;

    const install = page.consentController.install(request, "plugin:community-thing");
    await config.queued;
    provider.setContext(
      createContext(replacementGateway.gateway, undefined, undefined, config.harness),
    );
    await page.updateComplete;
    config.release.resolve();
    await install;

    expect(gatewayRequest).not.toHaveBeenCalledWith("plugins.install", request);
  });

  it("does not uninstall after its confirmed Gateway source changes while config writes drain", async () => {
    const removable = createPlugin({
      id: "community-thing",
      name: "Community Thing",
      origin: "global",
      removable: true,
      featured: false,
    });
    const result = {
      plugins: [createPlugin(), removable],
      diagnostics: [],
      mutationAllowed: true,
    } satisfies PluginListResult;
    const { client, request: gatewayRequest } = createClient(async (method) => {
      if (method === "plugins.uninstall") {
        return {
          ok: true,
          pluginId: "community-thing",
          restartRequired: true,
          removed: ["install record"],
        };
      }
      throw new Error(`Unexpected method ${method}`);
    });
    const initialGateway = createGateway(client);
    const replacementGateway = createGateway(client);
    const config = createQueuedRuntimeConfig(client);
    const initialContext = createContext(
      initialGateway.gateway,
      undefined,
      undefined,
      config.harness,
    );
    const { page, provider } = await mountPage(
      initialContext,
      createPluginsRouteData(initialGateway.gateway, result),
    );

    const uninstall = page.uninstall("community-thing", "plugin:community-thing");
    await config.queued;
    provider.setContext(
      createContext(replacementGateway.gateway, undefined, undefined, config.harness),
    );
    await page.updateComplete;
    config.release.resolve();
    await uninstall;

    expect(gatewayRequest).not.toHaveBeenCalledWith("plugins.uninstall", {
      pluginId: "community-thing",
    });
  });

  it("requires a fresh server review for install-policy acknowledgement after reconnect", async () => {
    const available = createPlugin({
      id: "community-thing",
      name: "Community Thing",
      origin: "global",
      installed: false,
      enabled: false,
      state: "not-installed",
      install: { source: "official", pluginId: "community-thing" },
    });
    let installCalls = 0;
    const { client } = createClient(async (method, params) => {
      if (method === "plugins.list") {
        return createResult(available);
      }
      if (method !== "plugins.install") {
        throw new Error(`Unexpected method ${method}`);
      }
      installCalls += 1;
      if (!(params as PluginInstallRequest).acknowledgeInstallPolicyWarning) {
        throw new GatewayRequestError({
          code: "INVALID_REQUEST",
          message: "install requires review",
          details: {
            installPolicyCode: "install_policy_warning_acknowledgement_required",
            targetName: "community-thing",
            targetType: "plugin",
            requestMode: "install",
            reason: "Review this plugin before installing it.",
          },
        });
      }
      return {
        ok: true,
        plugin: { ...available, installed: true },
        restartRequired: true,
      } satisfies PluginMutationResult;
    });
    const harness = createGateway(client);
    const { page } = await mountPage(
      createContext(harness.gateway),
      createPluginsRouteData(harness.gateway, createResult(available)),
    );
    const request = {
      source: "official",
      pluginId: "community-thing",
    } satisfies PluginInstallRequest;

    await page.consentController.install(request, "plugin:community-thing");
    expect(installCalls).toBe(1);
    expect(showConfirmDialog).not.toHaveBeenCalled();
    harness.emit(client, false);
    harness.emit(client, true);
    await page.consentController.install(
      { ...request, acknowledgeInstallPolicyWarning: true },
      "plugin:community-thing",
    );
    expect(installCalls).toBe(1);
    expect(page.messages["plugin:community-thing"]?.text).toContain("request a fresh review");
    await page.consentController.install(request, "plugin:community-thing");
    expect(installCalls).toBe(2);
    await page.consentController.install(
      { ...request, acknowledgeInstallPolicyWarning: true },
      "plugin:community-thing",
    );
    expect(installCalls).toBe(3);
    expect(showConfirmDialog).not.toHaveBeenCalled();
  });
});
