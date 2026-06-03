import { afterEach, describe, expect, it } from "vitest";
import { listCodexAppServerExtensionFactories } from "./codex-app-server-extension-factory.js";
import type { CodexAppServerExtensionFactory } from "./codex-app-server-extension-types.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import type { PluginCodexAppServerExtensionFactoryRegistration } from "./registry-types.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "./runtime.js";

afterEach(() => {
  resetPluginRuntimeStateForTest();
});

describe("listCodexAppServerExtensionFactories", () => {
  it("skips unreadable factory siblings while preserving healthy factories", () => {
    const registry = createEmptyPluginRegistry();
    const factory: CodexAppServerExtensionFactory = () => undefined;
    registry.codexAppServerExtensionFactories = [
      {
        pluginId: "broken-codex-ext",
        source: "test",
        get factory() {
          throw new Error("codex app factory getter exploded");
        },
      } as PluginCodexAppServerExtensionFactoryRegistration,
      {
        pluginId: "healthy-codex-ext",
        source: "test",
        rawFactory: factory,
        factory,
      } as PluginCodexAppServerExtensionFactoryRegistration,
    ];
    setActivePluginRegistry(registry);

    expect(listCodexAppServerExtensionFactories()).toEqual([factory]);
  });
});
