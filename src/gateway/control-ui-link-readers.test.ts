import {
  createPluginRegistryFixture,
  registerVirtualTestPlugin,
} from "openclaw/plugin-sdk/plugin-test-contracts";
import { Value } from "typebox/value";
import { afterEach, describe, expect, it } from "vitest";
import { PluginsUiDescriptorsResultSchema } from "../../packages/gateway-protocol/src/schema/plugins.js";
import type { PluginControlUiDescriptor } from "../plugins/host-hooks.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import { withPluginRuntimeRegistryScope } from "../plugins/runtime/gateway-request-scope.js";
import {
  listControlUiLinkReaders,
  listControlUiPluginDescriptors,
} from "./control-ui-plugin-tabs.js";
import {
  createGatewayMethodRegistry,
  createPluginGatewayMethodDescriptors,
} from "./methods/registry.js";

function setup() {
  const { config, registry } = createPluginRegistryFixture();
  const register = (
    id: string,
    methodScope: "operator.read" | "operator.write" = "operator.read",
    claimedMethod = id + ".read",
    imageMethod?: string,
  ) => {
    registerVirtualTestPlugin({
      registry,
      config,
      id,
      name: id,
      register(api) {
        api.session.controls.registerControlUiDescriptor({
          id: "document",
          label: id,
          surface: "link-reader",
          requiredScopes: ["operator.read"],
          linkReader: {
            hosts: [id + ".example"],
            pathPattern: "^/items/[0-9]+$",
            detailMethod: claimedMethod,
            ...(imageMethod ? { imageMethod } : {}),
          },
        });
        api.registerGatewayMethod(
          id + ".read",
          ({ respond }) => respond(true, { title: id }, undefined),
          { scope: methodScope },
        );
        api.registerGatewayMethod(id + ".image", ({ respond }) => respond(true, {}, undefined), {
          scope: "operator.read",
        });
      },
    });
  };
  setActivePluginRegistry(registry.registry);
  const methods = () =>
    createGatewayMethodRegistry(
      createPluginGatewayMethodDescriptors(registry.registry),
      registry.registry,
    );
  const readers = (scopes: readonly string[]) => listControlUiLinkReaders(scopes, methods());
  return { registry, register, readers, methods };
}

describe("plugin link-reader discovery", () => {
  afterEach(() => resetPluginRuntimeStateForTest());
  it.each([
    "valid",
    "foreign or stronger detail method",
    "missing image method",
    "writing image method",
  ])("advertises only live same-plugin read methods: %s", (kind) => {
    const { registry, register, readers, methods } = setup();
    const image = kind.endsWith("image method");
    register("notes", "operator.read", "notes.read", image ? "notes.image" : undefined);
    if (kind === "valid") {
      register("forge", "operator.read", "forge.read", "forge.image");
      expect(readers(["operator.read"]).map((reader) => reader.pluginId)).toEqual([
        "forge",
        "notes",
      ]);
      expect(readers(["operator.read"])[0]?.linkReader.imageMethod).toBe("forge.image");
      expect(readers([])).toEqual([]);
      expect(readers(["operator.admin"])).toHaveLength(2);
      expect(
        Value.Check(PluginsUiDescriptorsResultSchema, {
          ok: true,
          descriptors: listControlUiPluginDescriptors(["operator.read"]),
          methods: methods().listAdvertisedMethods(),
          controlUiLinkReaders: readers(["operator.read"]),
        }),
      ).toBe(true);
    } else {
      if (!image) {
        register("forge", "operator.read", "notes.read");
        register("writer", "operator.write");
        expect(readers(["operator.admin"]).map((reader) => reader.pluginId)).toEqual(["notes"]);
      }
      const method = registry.registry.gatewayMethodDescriptors.find(
        (entry) => entry.name === (image ? "notes.image" : "notes.read"),
      )!;
      if (kind === "missing image method") {
        registry.registry.gatewayMethodDescriptors.splice(
          registry.registry.gatewayMethodDescriptors.indexOf(method),
          1,
        );
      } else if (image) {
        method.controlPlaneWrite = true;
      } else {
        method.advertise = false;
      }
      expect(readers(["operator.admin"])).toEqual([]);
    }
  });
  it("does not retain a reader across owner disablement, rollback, or registry replacement", () => {
    const { registry, register, readers } = setup();
    register("forge");
    expect(readers(["operator.read"])).toHaveLength(1);
    registry.registry.plugins[0]!.status = "disabled";
    expect(readers(["operator.read"])).toEqual([]);
    registry.registry.plugins[0]!.status = "loaded";
    registry.rollbackPluginGlobalSideEffects("forge", registry.registry.plugins[0]!);
    expect(readers(["operator.read"])).toEqual([]);
    const replacement = createPluginRegistryFixture();
    setActivePluginRegistry(replacement.registry.registry);
    expect(readers(["operator.read"])).toEqual([]);
  });
  it("copies valid declaration data and rejects malformed or misplaced routing metadata", () => {
    const { config, registry } = createPluginRegistryFixture();
    const metadata = {
      hosts: ["forge.example"],
      pathPattern: "^/items/[0-9]+$",
      detailMethod: "forge.read",
    };
    const invalid: Array<Partial<PluginControlUiDescriptor>> = [
      { linkReader: { ...metadata, hosts: ["*.example"] } },
      { linkReader: { ...metadata, hosts: ["https://forge.example"] } },
      { linkReader: { ...metadata, pathPattern: "/items/" } },
      { linkReader: { ...metadata, pathPattern: "^[$" } },
      { surface: "tab", linkReader: metadata },
      { linkReader: { ...metadata, detailMethod: "" } },
      { linkReader: { ...metadata, imageMethod: "" } },
      { linkReader: { ...metadata, imageMethod: "notes image" } },
    ];
    registerVirtualTestPlugin({
      registry,
      config,
      id: "forge",
      name: "Forge",
      register(api) {
        api.session.controls.registerControlUiDescriptor({
          id: "valid",
          label: "Valid",
          surface: "link-reader",
          linkReader: metadata,
        });
        invalid.forEach((value, index) =>
          api.session.controls.registerControlUiDescriptor({
            id: "invalid-" + index,
            label: "Invalid",
            surface: "link-reader",
            ...value,
          }),
        );
      },
    });
    metadata.hosts.push("other.example");
    expect(registry.registry.controlUiDescriptors).toHaveLength(1);
    expect(registry.registry.controlUiDescriptors[0]?.descriptor.linkReader?.hosts).toEqual([
      "forge.example",
    ]);
    expect(registry.registry.diagnostics).toHaveLength(invalid.length);
  });
  it("does not mix a request's method snapshot with another active registry", () => {
    const { registry, register, methods } = setup();
    register("notes");
    const captured = methods();
    const replacement = createPluginRegistryFixture();
    setActivePluginRegistry(replacement.registry.registry);
    expect(listControlUiLinkReaders(["operator.read"], captured)).toEqual([]);
    const result = withPluginRuntimeRegistryScope(registry.registry, () =>
      listControlUiLinkReaders(["operator.read"], captured),
    );
    expect(result).toHaveLength(1);
  });
});
