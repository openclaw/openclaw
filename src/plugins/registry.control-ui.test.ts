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
  const reject = (message?: string, pluginId = "reports") => {
    expect(registry.registry.controlUiDescriptors).toEqual([]);
    expect(registry.registry.diagnostics).toContainEqual(
      expect.objectContaining({
        level: "error",
        pluginId,
        ...(message === undefined ? {} : { message: expect.stringContaining(message) }),
      }),
    );
  };
  const expectDescriptor = (pluginId: string, descriptor: Partial<PluginControlUiDescriptor>) =>
    expect(registry.registry.controlUiDescriptors).toEqual([
      expect.objectContaining({ pluginId, descriptor: expect.objectContaining(descriptor) }),
    ]);
  return { config, registry, register, reject, expectDescriptor };
}
const tab = { surface: "tab", id: "panel", label: "Reports" } as const;

describe("plugin registry Control UI descriptors", () => {
  it.each(["api", "health"])("rejects HTTP-owned tab slug %j", (slug) => {
    const { register, reject } = fixture();
    register({ ...tab, slug });
    reject("descriptor slug requires");
  });

  it("rejects a slug alongside native route placement", () => {
    const { register, reject } = fixture();
    register(
      { ...tab, placement: "route:reports", slug: "reports" },
      createPluginRecord({ id: "reports", origin: "bundled" }),
    );
    reject("descriptor slug requires");
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
    const { config, registry, expectDescriptor } = fixture();
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
    expectDescriptor("legacy-descriptor-fixture", {
      id: "legacy-card",
      surface: "session",
      label: "Legacy Card",
    });
  });

  it("accepts a bundled plugin's matching native route placement", () => {
    const { register, expectDescriptor } = fixture();
    const descriptor = {
      ...tab,
      placement: "route:workboard",
      icon: "kanban",
      group: "control" as const,
      order: 5,
      requiredScopes: ["operator.read"],
    } satisfies PluginControlUiDescriptor;
    register(descriptor, createPluginRecord({ id: "workboard", origin: "bundled" }));
    expectDescriptor("workboard", descriptor);
  });

  it.each([
    { id: "workboard", origin: "workspace" as const },
    { id: "logbook", origin: "bundled" as const },
  ])("rejects unowned native route placement from $origin plugin $id", ({ id, origin }) => {
    const { register, reject } = fixture();
    register({ ...tab, placement: "route:workboard" }, createPluginRecord({ id, origin }));
    reject("must be owned by its bundled plugin", id);
  });

  it("diagnoses UI declaration drift without rejecting registration", () => {
    const { registry, register, expectDescriptor } = fixture();
    register(
      {
        surface: "widget",
        id: "card",
        label: "Workboard card",
        requiredScopes: ["operator.read"],
      },
      createPluginRecord({ id: "workboard", uiCapabilities: [] }),
    );
    expect(registry.registry.diagnostics.filter(({ level }) => level === "warn")).toEqual([
      expect.objectContaining({
        pluginId: "workboard",
        message:
          'Registered UI capability "widget" is missing from uiCapabilities in openclaw.plugin.json.',
      }),
    ]);
    expectDescriptor("workboard", { id: "card", surface: "widget", label: "Workboard card" });
  });

  it("rejects protocol-relative tab paths that would iframe external content", () => {
    for (const path of ["//attacker.example/panel", "/\\attacker.example/panel"]) {
      const { register, reject } = fixture();
      register({ ...tab, path });
      reject();
    }
  });
});
