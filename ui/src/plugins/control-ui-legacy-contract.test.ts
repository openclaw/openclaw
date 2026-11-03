import { expectTypeOf, it } from "vitest";
import type {
  ControlUiAccessory,
  ControlUiComponents,
  ControlUiHost,
  ControlUiHostV2,
  ControlUiSettingsComponents,
  ControlUiSettingsContext,
  ControlUiSettingsPlacement,
} from "../../../src/plugin-sdk/control-ui.js";

// This consumer fixture uses only the pre-extension host shape. Adding a required
// host capability to the legacy interface makes this source stop compiling.
function legacyHost(components: ControlUiComponents): ControlUiHost {
  const stop = () => {};
  return {
    apiVersion: 1,
    pluginId: "legacy",
    signal: new AbortController().signal,
    basePath: "",
    locale: "en",
    redact: (text) => text,
    connection: {
      connected: false,
      canRead: false,
      canWrite: false,
      canGrant: false,
      canAdmin: false,
      assistantAgentId: null,
    },
    components,
    request: () => Promise.reject(new Error("Legacy fixture has no transport")),
    onEvent: () => stop,
    subscribe: () => stop,
    sessions: {
      rows: [],
      selectedKey: "main",
      normalizeKey: (key) => key,
      refresh: async () => {},
      observe: () => ({ refresh: async () => {}, dispose: stop }),
      open: stop,
      create: async () => null,
      patch: async () => {},
    },
    agents: {
      rows: [],
      selectedId: null,
      defaultId: null,
      scopeId: null,
      select: stop,
      setScope: stop,
      refresh: async () => {},
    },
    navigation: { openPage: stop, pageHref: () => "/" },
    ui: {
      invalidate: stop,
      registerPage: () => stop,
      registerNavigation: () => stop,
      pinNavigation: stop,
      unpinNavigation: stop,
      isNavigationPinned: () => false,
      registerPanel: () => stop,
      openPanel: stop,
      registerAction: () => stop,
      registerAccessory: () => stop,
      registerWidget: () => stop,
      registerInlineView: () => stop,
      registerReplacement: () => stop,
      selectReplacement: stop,
    },
  };
}

function legacyPlacement(placement: ControlUiSettingsPlacement): string {
  switch (placement.section) {
    case "memory":
      return placement.panel;
    case "channels":
      return placement.channelId;
    default:
      return placement satisfies never;
  }
}

it("keeps legacy host fixtures, accessory placements and Settings switches source-compatible", () => {
  expectTypeOf(legacyHost).returns.toEqualTypeOf<ControlUiHost>();
  expectTypeOf<ControlUiAccessory["placement"]>().toEqualTypeOf<"session-header">();
  expectTypeOf<
    Parameters<ControlUiSettingsComponents["mountSection"]>[1]["title"]
  >().toEqualTypeOf<string>();
  expectTypeOf<
    Parameters<ControlUiSettingsComponents["mountRow"]>[1]["title"]
  >().toEqualTypeOf<string>();
  expectTypeOf<
    ControlUiSettingsContext["components"]
  >().toEqualTypeOf<ControlUiSettingsComponents>();
  expectTypeOf(legacyPlacement).parameter(0).toEqualTypeOf<ControlUiSettingsPlacement>();
});

// New contribution views must receive the view-scoped V2 host, not only activation's host.
function registerV2Views(host: ControlUiHostV2) {
  host.ui.registerAction({
    id: "external",
    label: "External",
    placement: "session",
    run(context) {
      context.host.navigation.openExternal("https://example.test/review");
    },
  });
  host.ui.registerPage({
    id: "page",
    label: "Page",
    mount(_container, context) {
      context.host.requests.capture();
      return {
        update(next) {
          next.host.requests.capture();
        },
      };
    },
  });
  host.ui.registerPanel({
    id: "panel",
    label: "Panel",
    mount(_container, context) {
      context.host.requests.capture();
      return {
        update(next) {
          next.host.requests.capture();
        },
      };
    },
  });
  host.ui.registerWidget({
    id: "widget",
    label: "Widget",
    mount(_container, context) {
      context.host.requests.capture();
      return {
        update(next) {
          next.host.requests.capture();
        },
      };
    },
  });
  host.ui.registerReplacement({
    id: "composer",
    label: "Composer",
    surface: "composer",
    mount(_container, context) {
      context.host.requests.capture();
      return {
        update(next) {
          next.host.requests.capture();
        },
      };
    },
  });
}
it("makes new host capabilities available to each registered V2 view", () => {
  expectTypeOf(registerV2Views).parameter(0).toEqualTypeOf<ControlUiHostV2>();
});
