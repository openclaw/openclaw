import { describe, expect, it } from "vitest";
import { createTestPluginRegistry } from "./registry-runtime.test-helpers.js";
import { createPluginRecord } from "./status.test-fixtures.js";

describe("before_channel_ingress conversation policy", () => {
  it.each([false, true])(
    "honors explicit non-bundled conversation access: %s",
    (allowConversationAccess) => {
      const registry = createTestPluginRegistry();
      const record = createPluginRecord({ id: "prepared-content", origin: "workspace" });
      registry.registry.plugins.push(record);
      const api = registry.createApi(record, {
        config: {},
        hookPolicy: { allowConversationAccess },
      });
      api.on("before_channel_ingress", async () => ({ text: "Prepared" }));
      expect(
        registry.registry.typedHooks.some((hook) => hook.hookName === "before_channel_ingress"),
      ).toBe(allowConversationAccess);
    },
  );
});
