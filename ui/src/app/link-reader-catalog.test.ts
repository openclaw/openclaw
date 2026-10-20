/* @vitest-environment jsdom */

import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import type { ControlUiLinkReaderDescriptor } from "../../../src/shared/control-ui-link-reader.js";
import {
  createGatewayEvent,
  createGatewayStoreTestStore,
  GATEWAY_STORE_TEST_HELLO,
  stubGatewayStoreTestGlobals,
} from "./gateway-store.test-support.ts";
import { availableLinkReaders } from "./link-reader-routing.ts";

afterEach(() => vi.unstubAllGlobals());

it.each([
  ["sessionScoped", false, true],
  ["sessionScoped", true, false],
  ["progressive", false, true],
  ["progressive", true, false],
] as const)(
  "publishes %s changes from %s to %s on the existing connection",
  async (flag, before, after) => {
    stubGatewayStoreTestGlobals();
    const { gateway, current } = createGatewayStoreTestStore();
    onTestFinished(() => gateway.stop());
    gateway.start();
    const reader: ControlUiLinkReaderDescriptor = {
      pluginId: "forge",
      id: "items",
      label: "Forge",
      linkReader: {
        hosts: ["forge.example"],
        pathPattern: "^/items/[0-9]+$",
        detailMethod: "forge.detail",
        [flag]: before,
      },
    };
    current().opts.onHello?.({
      ...GATEWAY_STORE_TEST_HELLO,
      auth: { role: "operator", scopes: ["operator.read"] },
      features: { methods: ["forge.detail"] },
      controlUiLinkReaders: [reader],
    });
    const { client, hello } = gateway.snapshot;
    expect(availableLinkReaders(gateway.snapshot)[0]?.linkReader[flag]).toBe(before);

    current().request.mockResolvedValue({
      ok: true,
      descriptors: [],
      methods: ["forge.detail"],
      controlUiTabs: [],
      controlUiWidgetKinds: [],
      pluginSurfaceUrls: {},
      controlUiLinkReaders: [{ ...reader, linkReader: { ...reader.linkReader, [flag]: after } }],
    });
    current().opts.onEvent?.(
      createGatewayEvent("plugins.controlUi.changed", { revision: "updated" }),
    );
    await vi.waitFor(() =>
      expect(gateway.snapshot.pluginCapabilities?.controlUiLinkReaders?.[0]?.linkReader[flag]).toBe(
        after,
      ),
    );
    expect(gateway.snapshot.client).toBe(client);
    expect(gateway.snapshot.hello).toBe(hello);
    expect(availableLinkReaders(gateway.snapshot)[0]?.linkReader[flag]).toBe(after);
  },
);
