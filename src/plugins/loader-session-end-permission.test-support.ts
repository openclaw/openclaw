import { expect, it } from "vitest";
import { useNoBundledPlugins, writePlugin } from "./loader.test-fixtures.js";
import { loadRegistryFromSinglePlugin } from "./loader.test-harness.js";

it.each([
  { allowConversationAccess: undefined, expectedGrant: undefined },
  { allowConversationAccess: true, expectedGrant: true as const },
])(
  "keeps metadata-only session_end registered with resolved conversation grant $expectedGrant",
  ({ allowConversationAccess, expectedGrant }) => {
    useNoBundledPlugins();
    const plugin = writePlugin({
      id: "session-end-reader",
      filename: "session-end-reader.cjs",
      registration: `api.on("session_end", () => undefined);`,
    });
    const registry = loadRegistryFromSinglePlugin({
      plugin,
      pluginConfig: {
        allow: ["session-end-reader"],
        ...(allowConversationAccess === undefined
          ? {}
          : {
              entries: {
                "session-end-reader": { hooks: { allowConversationAccess } },
              },
            }),
      },
    });

    expect(registry.typedHooks).toHaveLength(1);
    expect(registry.typedHooks[0]?.hookName).toBe("session_end");
    expect(registry.typedHooks[0]?.conversationAccessAllowed).toBe(expectedGrant);
  },
);
