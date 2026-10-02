import {
  createPluginRegistryFixture,
  registerTestPlugin,
} from "openclaw/plugin-sdk/plugin-test-contracts";
import { describe, expect, it } from "vitest";
import type { PluginControlUiDescriptor } from "./host-hooks.js";
import { createPluginRecord } from "./status.test-fixtures.js";

function fixture() {
  const { config, registry } = createPluginRegistryFixture();
  const register = (
    descriptor: PluginControlUiDescriptor,
    record = createPluginRecord({ id: "reports" }),
  ) =>
    registerTestPlugin({
      registry,
      config,
      record,
      register(api) {
        api.session.controls.registerControlUiDescriptor(descriptor);
      },
    });
  return { config, registry, register };
}
const tab = { surface: "tab", id: "panel", label: "Reports" } as const;

describe("plugin registry Control UI descriptors", () => {
  it.each(["Reports", " reports", "a".repeat(65), "api", "health"])(
    "rejects invalid or HTTP-owned tab slug %j",
    (slug) => {
      const { registry, register } = fixture();
      register({ ...tab, slug });
      expect(registry.registry.controlUiDescriptors).toEqual([]);
      expect(registry.registry.diagnostics).toContainEqual(
        expect.objectContaining({
          level: "error",
          pluginId: "reports",
          message: expect.stringContaining("descriptor slug requires"),
        }),
      );
    },
  );

  it.each([
    { surface: "widget" as const },
    { surface: "tab" as const, placement: "route:reports" },
  ])("rejects slug on $surface with placement $placement", (fields) => {
    const { registry, register } = fixture();
    register(
      { ...tab, ...fields, slug: "reports" },
      createPluginRecord({ id: "reports", origin: "bundled" }),
    );
    expect(registry.registry.controlUiDescriptors).toEqual([]);
    expect(registry.registry.diagnostics).toContainEqual(
      expect.objectContaining({
        level: "error",
        message: expect.stringContaining("descriptor slug requires"),
      }),
    );
  });

  it("keeps the first plugin's tab when a later plugin claims its slug", () => {
    const { registry, register } = fixture();
    const slug = "a".repeat(64);
    for (const id of ["first", "later"]) {
      register({ ...tab, slug }, createPluginRecord({ id }));
    }
    expect(
      registry.registry.controlUiDescriptors.map(({ pluginId, descriptor }) => [
        pluginId,
        descriptor.slug,
      ]),
    ).toEqual([["first", slug]]);
    expect(registry.registry.httpRoutes).toEqual([]);
    expect(registry.registry.diagnostics).toContainEqual(
      expect.objectContaining({
        level: "error",
        pluginId: "later",
        message: `control UI tab slug already registered by first: ${slug}`,
      }),
    );
  });

  it("keeps legacy flat descriptors loadable for shipped JavaScript plugins", () => {
    const { config, registry } = fixture();
    registerTestPlugin({
      registry,
      config,
      record: createPluginRecord({ id: "legacy-descriptor-fixture" }),
      register(api) {
        api.registerControlUiDescriptor({
          id: "legacy-card",
          name: "Legacy Card",
          description: "Legacy descriptor from a JavaScript plugin",
        } as never);
      },
    });
    expect(registry.registry.controlUiDescriptors).toEqual([
      expect.objectContaining({
        pluginId: "legacy-descriptor-fixture",
        descriptor: expect.objectContaining({
          id: "legacy-card",
          surface: "session",
          label: "Legacy Card",
        }),
      }),
    ]);
  });

  it("accepts a bundled plugin's matching native route placement", () => {
    const { registry, register } = fixture();
    const descriptor = {
      ...tab,
      placement: "route:workboard",
      icon: "kanban",
      group: "control" as const,
      order: 5,
      requiredScopes: ["operator.read"],
    } satisfies PluginControlUiDescriptor;
    register(descriptor, createPluginRecord({ id: "workboard", origin: "bundled" }));
    expect(registry.registry.controlUiDescriptors).toEqual([
      expect.objectContaining({
        pluginId: "workboard",
        descriptor: expect.objectContaining(descriptor),
      }),
    ]);
  });

  it.each([
    { id: "workboard", origin: "workspace" as const },
    { id: "logbook", origin: "bundled" as const },
  ])("rejects unowned native route placement from $origin plugin $id", ({ id, origin }) => {
    const { registry, register } = fixture();
    register({ ...tab, placement: "route:workboard" }, createPluginRecord({ id, origin }));
    expect(registry.registry.controlUiDescriptors).toEqual([]);
    expect(registry.registry.diagnostics).toContainEqual(
      expect.objectContaining({
        level: "error",
        pluginId: id,
        message: expect.stringContaining("must be owned by its bundled plugin"),
      }),
    );
  });

  it.each([
    { uiCapabilities: [], warns: true },
    { uiCapabilities: ["widget", "panel"] as const, warns: false },
  ])(
    "diagnoses UI declaration drift without rejecting registration: $uiCapabilities",
    ({ uiCapabilities, warns }) => {
      const { registry, register } = fixture();
      register(
        {
          surface: "widget",
          id: "card",
          label: "Workboard card",
          requiredScopes: ["operator.read"],
        },
        createPluginRecord({ id: "workboard", uiCapabilities: [...uiCapabilities] }),
      );
      expect(registry.registry.diagnostics.filter(({ level }) => level === "warn")).toEqual(
        warns
          ? [
              expect.objectContaining({
                pluginId: "workboard",
                message:
                  'Registered UI capability "widget" is missing from uiCapabilities in openclaw.plugin.json.',
              }),
            ]
          : [],
      );
      expect(registry.registry.controlUiDescriptors).toEqual([
        expect.objectContaining({
          pluginId: "workboard",
          descriptor: expect.objectContaining({
            id: "card",
            surface: "widget",
            label: "Workboard card",
          }),
        }),
      ]);
    },
  );

  it("rejects protocol-relative tab paths that would iframe external content", () => {
    for (const path of ["//attacker.example/panel", "/\\attacker.example/panel"]) {
      const { registry, register } = fixture();
      register({ ...tab, path });
      expect(registry.registry.controlUiDescriptors).toEqual([]);
      expect(registry.registry.diagnostics).toContainEqual(
        expect.objectContaining({ level: "error", pluginId: "reports" }),
      );
    }
  });

  it("rejects tab descriptors whose path is not absolute", () => {
    const { registry, register } = fixture();
    register({ ...tab, path: "relative/frame.html" });
    expect(registry.registry.controlUiDescriptors).toEqual([]);
    expect(registry.registry.diagnostics).toContainEqual(
      expect.objectContaining({
        level: "error",
        pluginId: "reports",
        message: expect.stringContaining("gateway-local absolute path"),
      }),
    );
  });
});
