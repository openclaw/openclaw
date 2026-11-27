import { createRoot } from "solid-js";
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { ApplicationContext } from "../../app/context.ts";
import type { PluginListResult } from "../../lib/plugins/index.ts";
import { createApplicationGateway } from "../../test-helpers/application-context.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import { createChannelPluginPresentation } from "./plugin-presentation-loader.ts";

it.each(["pending", "loaded"] as const)(
  "retires %s channel plugin metadata when read access is revoked",
  async (phase) => {
    const pending = createDeferred<PluginListResult>();
    const result: PluginListResult = {
      plugins: [
        {
          id: "slack",
          name: "Private workspace",
          installed: true,
          enabled: true,
          state: "enabled",
        },
      ],
      diagnostics: [],
      mutationAllowed: false,
    };
    const client = createTestGatewayClient(
      vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValue(result),
    );
    const request = vi.spyOn(client, "request");
    const { gateway } = createApplicationGateway();
    Object.assign(gateway.snapshot, {
      client,
      phase: "connected",
      hello: gatewayHelloForMethods(["plugins.list"], ["operator.read"]),
    });
    // SAFETY: metadata without icons only consumes the Gateway from this application fixture.
    const context = { gateway } as ApplicationContext;
    let dispose!: () => void;
    const presentation = createRoot((stop) => {
      dispose = stop;
      return createChannelPluginPresentation({
        getContext: () => context,
        getProps: () => {
          throw new Error("This metadata fixture does not mount a Settings view");
        },
        getConnection: () => {
          throw new Error("This metadata fixture does not start a Settings operation");
        },
        getChannelIds: () => [],
        isConnected: () => gateway.snapshot.phase === "connected",
      });
    });
    try {
      presentation.ensure(client);
      expect(request).toHaveBeenCalledOnce();
      if (phase === "loaded") {
        pending.resolve(result);
        await waitForSolid(() =>
          expect(presentation.pluginCatalog?.plugins[0]?.name).toBe("Private workspace"),
        );
      }

      gateway.snapshot.hello = gatewayHelloForMethods(["plugins.list"], []);
      presentation.ensure(client);
      expect(presentation.pluginCatalog).toBeNull();
      pending.resolve(result);
      await request.mock.results[0]!.value;
      expect(presentation.pluginCatalog).toBeNull();
      expect(request).toHaveBeenCalledOnce();

      gateway.snapshot.hello = gatewayHelloForMethods(["plugins.list"], ["operator.read"]);
      presentation.ensure(client);
      await waitForSolid(() =>
        expect(presentation.pluginCatalog?.plugins[0]?.name).toBe("Private workspace"),
      );
      expect(request).toHaveBeenCalledTimes(2);
    } finally {
      dispose();
    }
  },
);
