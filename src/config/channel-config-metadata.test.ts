import { describe, expect, it } from "vitest";
import type { PluginManifestRecord } from "../plugins/manifest-registry.js";
import { createPluginManifestRecordFixture } from "../plugins/plugin-metadata.test-support.js";
import {
  collectChannelDmPolicyMetadata,
  collectChannelSchemaMetadataWithOwnership,
  collectPluginSchemaMetadataCore,
} from "./channel-config-metadata.js";

const manifestRegistry = (
  ...plugins: Parameters<typeof createPluginManifestRecordFixture>[0][]
) => ({ diagnostics: [], plugins: plugins.map(createPluginManifestRecordFixture) });

function createChannelSchemaRegistry(
  channelId: string,
  schema: Record<string, unknown>,
  origin: PluginManifestRecord["origin"] = "global",
) {
  return manifestRegistry({
    id: "deep-channel-schema-plugin",
    channels: [channelId],
    channelConfigs: { [channelId]: { schema } },
    origin,
  });
}

function deepSchema() {
  let schema: Record<string, unknown> = { type: "object" };
  for (let depth = 0; depth < 3_000; depth++) {
    schema = { type: "object", properties: { nested: schema } };
  }
  return schema;
}

describe("collectPluginSchemaMetadataCore", () => {
  it("preserves provider ownership and order independently of plugin origin selection", () => {
    const shared = { family: "shared" };
    const later = { family: "later" };
    const prototypeNamed = { family: "prototype-named" };
    const registry = manifestRegistry(
      {
        id: "z-first",
        providerRequest: { providers: { shared: { family: "superseded" } } },
      },
      {
        id: "a-last",
        origin: "config",
        name: "Selected origin",
        providerRequest: {
          providers: { later, shared, ["__proto__"]: prototypeNamed },
        },
      },
      {
        id: "a-last",
        origin: "bundled",
        name: "Shadowed origin",
        providerRequest: { providers: { shadowOnly: { family: "shadow" } } },
      },
      { id: "plain" },
    );
    const before = structuredClone(registry);
    const metadata = collectPluginSchemaMetadataCore(registry);
    expect(metadata.map(({ id }) => id)).toEqual(["a-last", "plain", "z-first"]);
    expect(metadata[0]?.name).toBe("Selected origin");
    const providers = metadata[0]?.providerRequest?.providers;
    expect(Object.keys(providers!)).toEqual(["shared", "later", "__proto__"]);
    expect(providers?.shared).toBe(shared);
    expect(providers?.later).toBe(later);
    expect(Object.getOwnPropertyDescriptor(providers, "__proto__")?.value).toBe(prototypeNamed);
    expect(Object.getPrototypeOf(providers)).toBe(Object.prototype);
    expect(metadata[1]?.providerRequest).toBeUndefined();
    expect(metadata[2]?.providerRequest).toEqual({ providers: {} });
    expect(registry).toEqual(before);
  });
});

describe("collectChannelSchemaMetadataWithOwnership", () => {
  it.each(
    ["core", "plus", undefined].flatMap((selected) =>
      [false, true].map((reverse) => ({ selected, reverse })),
    ),
  )(
    "preserves every owner's sensitivity with $selected selected and reverse=$reverse",
    ({ selected, reverse }) => {
      const schema = {
        type: "object",
        properties: { core: { type: "string" }, plus: { type: "string" } },
      };
      const registry = manifestRegistry(
        ...["core", "plus"].map((id) => ({
          id,
          origin: "global" as const,
          channels: ["proofchat"],
          channelConfigs: {
            proofchat: {
              schema,
              label: id,
              uiHints: {
                [id]: { sensitive: true, label: id },
                [id === "core" ? "plus" : "core"]: {
                  sensitive: false,
                  label: "selected presentation",
                },
                [id === "core" ? " .endpoint " : "endpoint"]: {
                  sensitive: false,
                  tags: id === "core" ? ["url-secret", "inactive-tag"] : ["selected-tag"],
                  label: id,
                },
                [`accounts.*.${id}`]: { sensitive: true },
                [`entries[].${id}`]: { sensitive: true },
                [id === "core" ? " .shared " : "shared"]: { sensitive: id === "core", label: id },
              },
            },
          },
        })),
      );
      if (reverse) {
        registry.plugins.reverse();
      }
      const before = structuredClone(registry);
      const owner = selected ?? registry.plugins.at(-1)?.id;
      const channels = collectChannelSchemaMetadataWithOwnership(
        registry,
        selected ? new Set([selected]) : undefined,
      );
      expect(channels[0]).toMatchObject({ label: owner, schemaPluginId: owner });
      expect(channels[0]?.configSchema?.properties).toMatchObject(schema.properties);
      const hints = channels[0]?.configUiHints;
      for (const path of "core plus shared accounts.*.core accounts.*.plus entries[].core entries[].plus".split(
        " ",
      )) {
        expect(hints?.[path]?.sensitive, path).toBe(true);
      }
      expect(hints?.endpoint).toMatchObject({ sensitive: false, label: owner });
      expect(hints?.endpoint?.tags).toEqual(
        owner === "core" ? ["url-secret", "inactive-tag"] : ["selected-tag", "url-secret"],
      );
      expect(registry).toEqual(before);
    },
  );

  // The producer's traversal bound must not depend on the runtime stack limit.
  it("surfaces the raw deeply nested external schema after bounded traversal", () => {
    const schema = deepSchema();

    const entries = collectChannelSchemaMetadataWithOwnership(
      createChannelSchemaRegistry("qqbot", schema),
    );
    expect(entries[0]).toMatchObject({ id: "qqbot" });
    expect(entries[0]?.configSchema).toBe(schema);
  });

  it("keeps bundled schema preparation failures on the throwing path", () => {
    expect(() =>
      collectChannelSchemaMetadataWithOwnership(
        createChannelSchemaRegistry("qqbot", deepSchema(), "bundled"),
      ),
    ).toThrow("channel config schema exceeds maximum traversal depth of 256");
  });
});

describe("collectChannelDmPolicyMetadata", () => {
  it.each([
    { name: "missing official capability", declared: undefined, expected: false },
    { name: "explicit required wildcard", declared: true, expected: true },
    { name: "explicit wildcard exemption", declared: false, expected: false },
    { name: "different plugin ID", pluginId: "lookalike-qqbot", expected: undefined },
    { name: "different package", packageName: "community-qqbot", expected: undefined },
    { name: "legacy package", packageName: "@openclaw/qqbot", expected: undefined },
    { name: "different package channel", packageChannelId: "other-chat", expected: undefined },
    {
      name: "explicit community capability",
      pluginId: "community-chat",
      packageName: "community-chat",
      declared: false,
      expected: false,
    },
  ])(
    "resolves $name",
    ({
      pluginId = "openclaw-qqbot",
      packageName = "@tencent-connect/openclaw-qqbot",
      packageChannelId = "qqbot",
      declared,
      expected,
    }) => {
      const metadata = collectChannelDmPolicyMetadata(
        manifestRegistry({
          id: pluginId,
          channels: ["qqbot", "unrelated-chat"],
          packageName,
          packageChannel: {
            id: packageChannelId,
            ...(declared === undefined
              ? {}
              : { doctorCapabilities: { openDmRequiresAllowFromWildcard: declared } }),
          },
        }),
      );
      expect(metadata.get("qqbot")?.openDmRequiresAllowFromWildcard).toBe(expected);
      expect(metadata.get("unrelated-chat")).toEqual({ id: "unrelated-chat" });
    },
  );

  it("retains closest-origin nested metadata when no channel owner is selected", () => {
    const registry = manifestRegistry(
      ...(["config", "global"] as const).map((origin) => ({
        id: `${origin}-chat`,
        origin,
        channels: ["proofchat"],
        packageChannel: {
          id: "proofchat",
          doctorCapabilities:
            origin === "config"
              ? { dmAllowFromMode: "nestedOnly" as const, openDmRequiresAllowFromWildcard: false }
              : { openDmRequiresAllowFromWildcard: true },
        },
      })),
    );
    expect(collectChannelDmPolicyMetadata(registry, new Set<string>()).get("proofchat")).toEqual({
      id: "proofchat",
      dmAllowFromMode: "nestedOnly",
      openDmRequiresAllowFromWildcard: false,
    });
  });
});
