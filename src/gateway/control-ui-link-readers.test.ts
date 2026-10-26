import {
  createPluginRegistryFixture,
  registerVirtualTestPlugin,
} from "openclaw/plugin-sdk/plugin-test-contracts";
import { Value } from "typebox/value";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PluginsUiDescriptorsResultSchema } from "../../packages/gateway-protocol/src/schema/plugins.js";
import type { PluginControlUiDescriptor } from "../plugins/host-hooks.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import { withPluginRuntimeRegistryScope } from "../plugins/runtime/gateway-request-scope.js";
import {
  listControlUiLinkReaders,
  listControlUiPluginDescriptors,
} from "./control-ui-plugin-tabs.js";
import { createGatewayMethodRegistry } from "./methods/registry.js";

function descriptor(
  id: string,
  fields: Partial<PluginControlUiDescriptor & { surface: "link-reader" | "tab" }>,
) {
  return { id, label: id, surface: "link-reader" as const, ...fields };
}

function setup() {
  const { config, registry } = createPluginRegistryFixture();
  const register = (
    id: string,
    options: {
      write?: boolean;
      detail?: string;
      image?: boolean;
      declarations?: PluginControlUiDescriptor[];
    } = {},
  ) => {
    const declarations = options.declarations ?? [
      descriptor("document", {
        requiredScopes: ["operator.read"],
        linkReader: {
          hosts: [id + ".example"],
          pathPattern: "^/items/[0-9]+$",
          detailMethod: options.detail ?? id + ".read",
          ...(options.image ? { imageMethod: id + ".image" } : {}),
        },
      }),
    ];
    registerVirtualTestPlugin({
      registry,
      config,
      id,
      name: id,
      register(api) {
        declarations.forEach((declaration) =>
          api.session.controls.registerControlUiDescriptor(declaration),
        );
        api.registerGatewayMethod(id + ".read", () => undefined, {
          scope: options.write ? "operator.write" : "operator.read",
        });
        api.registerGatewayMethod(id + ".image", () => undefined, { scope: "operator.read" });
      },
    });
  };
  setActivePluginRegistry(registry.registry);
  const methods = () =>
    createGatewayMethodRegistry(registry.registry.gatewayMethodDescriptors, registry.registry);
  const readers = (scopes: readonly string[]) => listControlUiLinkReaders(scopes, methods());
  return { registry, register, readers, methods };
}

describe("plugin link-reader discovery", () => {
  afterEach(() => resetPluginRuntimeStateForTest());
  it("does not index methods when no link readers are visible", () => {
    const { register, methods } = setup();
    register("panel", {
      declarations: [descriptor("panel", { surface: "tab", path: "/panel" })],
    });
    register("private", {
      declarations: [
        descriptor("document", {
          requiredScopes: ["operator.admin"],
          linkReader: {
            hosts: ["private.example"],
            pathPattern: "^/items/[0-9]+$",
            detailMethod: "private.read",
          },
        }),
      ],
    });
    const registry = methods();
    using descriptors = vi.spyOn(registry, "descriptors");

    expect(listControlUiLinkReaders(["operator.read"], registry)).toEqual([]);
    expect(descriptors).not.toHaveBeenCalled();
  });
  it.each([
    "valid",
    "foreign or stronger detail method",
    "missing image method",
    "writing image method",
  ])("advertises only live same-plugin read methods: %s", (kind) => {
    const { registry, register, readers, methods } = setup();
    const image = kind.endsWith("image method");
    register("notes", { image });
    if (kind === "valid") {
      register("forge", { image: true });
      expect(readers(["operator.read"])).toMatchObject([
        { pluginId: "forge", linkReader: { imageMethod: "forge.image" } },
        { pluginId: "notes" },
      ]);
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
        register("forge", { detail: "notes.read" });
        register("writer", { write: true });
        expect(readers(["operator.admin"]).map((reader) => reader.pluginId)).toEqual(["notes"]);
      }
      const descriptors = registry.registry.gatewayMethodDescriptors;
      const method = descriptors.find(
        (entry) => entry.name === (image ? "notes.image" : "notes.read"),
      )!;
      if (kind === "missing image method") {
        descriptors.splice(descriptors.indexOf(method), 1);
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
    const { registry, register } = setup();
    const metadata = {
      hosts: ["forge.example"],
      pathPattern: "^/items/[0-9]+$",
      detailMethod: "forge.read",
    };
    const invalid: Parameters<typeof descriptor>[1][] = [
      { linkReader: { ...metadata, hosts: ["*.example"] } },
      { linkReader: { ...metadata, hosts: ["https://forge.example"] } },
      { linkReader: { ...metadata, pathPattern: "/items/" } },
      { linkReader: { ...metadata, pathPattern: "^[$" } },
      { surface: "tab", linkReader: metadata },
      { linkReader: { ...metadata, detailMethod: "" } },
      { linkReader: { ...metadata, imageMethod: "" } },
      { linkReader: { ...metadata, imageMethod: "notes image" } },
    ];
    register("forge", {
      declarations: [
        descriptor("valid", { linkReader: metadata }),
        ...invalid.map((value, index) => descriptor("invalid-" + index, value)),
      ],
    });
    metadata.hosts.push("other.example");
    expect(registry.registry.controlUiDescriptors).toMatchObject([
      { descriptor: { linkReader: { hosts: ["forge.example"] } } },
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
