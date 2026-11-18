import { expect, it } from "vitest";
import { useNoBundledPlugins, writePlugin } from "./loader.test-fixtures.js";
import { loadRegistryFromSinglePlugin } from "./loader.test-harness.js";

const conversation = { allowConversationAccess: true };
it.each([
  ["unset", conversation, [], "allowModelRequest=true to enable it"],
  ["false", { ...conversation, allowModelRequest: false }, [], "allowModelRequest=true to enable"],
  ["true", { ...conversation, allowModelRequest: true }, ["before_model_request"], undefined],
  ["true without conversation access", { allowModelRequest: true }, [], "allowConversationAccess"],
  [
    "true with prompt modification off",
    { ...conversation, allowModelRequest: true, allowPromptModification: false },
    [],
    "allowPromptModification=false",
  ],
] as const)(
  "gates before_model_request on the explicit opt-in (%s)",
  (_name, hooks, names, why) => {
    useNoBundledPlugins();
    const plugin = writePlugin({
      id: "model-request",
      filename: "model-request.cjs",
      registration: `api.on("before_model_request", () => undefined);`,
    });
    const registry = loadRegistryFromSinglePlugin({
      plugin,
      pluginConfig: { allow: ["model-request"], entries: { "model-request": { hooks } } },
    });

    expect(registry.typedHooks.map((entry) => entry.hookName)).toEqual(names);
    const warnings = registry.diagnostics.filter((entry) => entry.message.includes("typed hook"));
    expect(warnings.map((entry) => entry.level)).toEqual(why ? ["warn"] : []);
    if (why) {
      expect(warnings[0]?.message).toContain(why);
    }
  },
);
