import { expect, it, vi } from "vitest";
import { validateConfigObjectRawWithPlugins } from "./validation.js";

const reads = vi.hoisted(() => new Set<string>());
vi.mock(import("./bundled-channel-config-metadata.generated.js"), async (importOriginal) => {
  const original = await importOriginal();
  const entries = original.GENERATED_BUNDLED_CHANNEL_CONFIG_METADATA;
  return {
    ...original,
    GENERATED_BUNDLED_CHANNEL_CONFIG_METADATA: entries.map(
      (entry) =>
        new Proxy(entry, {
          get(target, key, receiver) {
            if (key === "schema" || key === "uiHints") {
              reads.add(entry.channelId);
            }
            return Reflect.get(target, key, receiver);
          },
        }),
    ),
  };
});

it("reads bundled channel schemas only for authored channel settings", () => {
  const options = {
    pluginMetadataSnapshot: { manifestRegistry: { plugins: [], diagnostics: [] } },
  };
  expect(validateConfigObjectRawWithPlugins({}, options).ok).toBe(true);
  expect([...reads]).toEqual([]);
  const result = validateConfigObjectRawWithPlugins(
    { channels: { telegram: { enabled: "invalid" } } },
    options,
  );
  expect(result.ok).toBe(false);
  expect([...reads]).toEqual(["telegram"]);
});
