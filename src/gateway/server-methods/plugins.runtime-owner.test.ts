import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, vi } from "vitest";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import type { PluginServiceRegistration } from "../../plugins/registry-types.js";
import {
  captureActivePluginRegistrySnapshot,
  createPluginRegistryOwner,
  getActivePluginRegistryVersion,
  restoreActivePluginRegistrySnapshot,
  setActivePluginRegistry,
} from "../../plugins/runtime.js";
import { withPluginRuntimeGatewayRequestScope } from "../../plugins/runtime/gateway-request-scope.js";
import { createPluginServiceHealthReporter } from "../../plugins/service-health.js";
import { createPluginRecord } from "../../plugins/status.test-helpers.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import type { GatewayRequestContext } from "./types.js";

const catalogRead = vi.hoisted(() =>
  vi.fn<typeof import("../../plugins/management-service.js").listManagedPlugins>(),
);
vi.mock("../../plugins/management-service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../plugins/management-service.js")>()),
  listManagedPlugins: catalogRead,
}));

const { pluginsHandlers } = await import("./plugins.js");

it.each(
  (["same Gateway", "other Gateway", "same registry"] as const).flatMap((publication) =>
    (["before handler", "during catalog"] as const).map((timing) => ({ publication, timing })),
  ),
)(
  "pairs request runtime health with its generation across $publication publication $timing",
  async ({ publication, timing }) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const catalog = {
        plugins: [
          {
            id: "colliding-plugin",
            name: "Request plugin",
            installed: true,
            enabled: true,
            state: "enabled" as const,
          },
        ],
        diagnostics: [],
        mutationAllowed: true,
      };
      const release = createDeferredCore<typeof catalog>();
      catalogRead.mockReset();
      catalogRead.mockReturnValueOnce(release.promise);
      const previous = captureActivePluginRegistrySnapshot();
      const requestRegistry = createEmptyPluginRegistry();
      requestRegistry.plugins.push(createPluginRecord({ id: "colliding-plugin" }));
      const service = {
        pluginId: "colliding-plugin",
        source: "fixture",
        origin: "workspace",
        service: { id: "request-service", start: vi.fn() },
      } satisfies PluginServiceRegistration;
      requestRegistry.services.push(service);
      const reporter = createPluginServiceHealthReporter(service);
      setActivePluginRegistry(requestRegistry);
      const requestOwner = createPluginRegistryOwner(requestRegistry);
      const requestGeneration = getActivePluginRegistryVersion();
      const enterHandler = createDeferredCore();
      let unrelatedOwner: ReturnType<typeof createPluginRegistryOwner> | undefined;
      const respond = vi.fn();
      const handler = expectDefined(pluginsHandlers["plugins.list"], "plugins.list handler");
      const request = withPluginRuntimeGatewayRequestScope(
        { pluginRegistry: requestOwner.registry, isWebchatConnect: () => false },
        async () => {
          await enterHandler.promise;
          return handler({
            req: { type: "req", id: "runtime-owner", method: "plugins.list", params: {} },
            params: {},
            client: null,
            isWebchatConnect: () => false,
            context: { getRuntimeConfig: () => ({}) } as GatewayRequestContext,
            respond,
          });
        },
      );
      const failures: unknown[] = [];
      try {
        if (timing === "during catalog") {
          enterHandler.resolve();
          await vi.waitFor(() => expect(catalogRead).toHaveBeenCalledOnce());
        }
        const unrelatedRegistry = createEmptyPluginRegistry();
        unrelatedRegistry.plugins.push(
          createPluginRecord({ id: "colliding-plugin", enabled: false, status: "disabled" }),
        );
        setActivePluginRegistry(
          publication === "same registry" ? requestRegistry : unrelatedRegistry,
        );
        if (publication === "same Gateway") {
          requestOwner.publish(unrelatedRegistry);
        } else {
          unrelatedOwner = createPluginRegistryOwner(unrelatedRegistry);
        }
        const nextGeneration = getActivePluginRegistryVersion();
        expect(nextGeneration).toBeGreaterThan(requestGeneration);
        enterHandler.resolve();
        await vi.waitFor(() => expect(catalogRead).toHaveBeenCalledOnce());
        reporter.health.reportFailure(new Error("late request-owner service failure"));
        release.resolve(catalog);
        await request;
        expect(respond).toHaveBeenCalledExactlyOnceWith(
          true,
          expect.objectContaining({
            generation: publication === "same registry" ? nextGeneration : requestGeneration,
            plugins: [
              expect.objectContaining({
                id: "colliding-plugin",
                runtime: {
                  state: "service-failed",
                  error: "request-service: late request-owner service failure",
                },
              }),
            ],
          }),
          undefined,
        );
        expect(service.service.start).not.toHaveBeenCalled();
      } catch (error) {
        failures.push(error);
      } finally {
        enterHandler.resolve();
        release.resolve(catalog);
        await Promise.allSettled([request]);
        reporter.revoke();
        const results = await Promise.allSettled([requestOwner.close(), unrelatedOwner?.close()]);
        restoreActivePluginRegistrySnapshot(previous);
        failures.push(
          ...results.flatMap((result) => (result.status === "rejected" ? [result.reason] : [])),
        );
      }
      if (failures.length) {
        throw new AggregateError(failures, "Plugin inventory assertion or registry cleanup failed");
      }
    });
  },
);
