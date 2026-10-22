import { describe, expect, it } from "vitest";
import type { PluginControlUiDescriptor } from "./host-hooks.js";
import { expectDiagnostic, registrationFixture } from "./registry-registration.test-support.js";

const tab = { surface: "tab", id: "panel", label: "Reports" } as const;
function fixture() {
  const { registry, register: registerPlugin } = registrationFixture();
  const register = (
    descriptor: PluginControlUiDescriptor,
    fields: Parameters<typeof registerPlugin>[0] = { id: "reports" },
  ) =>
    registerPlugin(fields, (api) => api.session.controls.registerControlUiDescriptor(descriptor));
  const expectDescriptor = (pluginId: string, descriptor: Partial<PluginControlUiDescriptor>) =>
    expect(registry.controlUiDescriptors).toEqual([
      expect.objectContaining({ pluginId, descriptor: expect.objectContaining(descriptor) }),
    ]);
  return { registry, register, registerPlugin, expectDescriptor };
}

describe("plugin registry Control UI descriptors", () => {
  it.each([
    ["reserved API slug", { slug: "api" }, {}, "descriptor slug requires"],
    ["HTTP health slug", { slug: "health" }, {}, "descriptor slug requires"],
    [
      "slug with native route",
      { slug: "reports", placement: "route:reports" },
      { origin: "bundled" },
      "descriptor slug requires",
    ],
    [
      "workspace native route",
      { placement: "route:workboard" },
      { id: "workboard", origin: "workspace" },
      "must be owned by its bundled plugin",
    ],
    [
      "foreign bundled route",
      { placement: "route:workboard" },
      { id: "logbook", origin: "bundled" },
      "must be owned by its bundled plugin",
    ],
    ["protocol-relative path", { path: "//attacker.example/panel" }, {}, undefined],
    ["backslash host path", { path: "/\\attacker.example/panel" }, {}, undefined],
  ] as const)("rejects %s", (_name, descriptor, fields, message) => {
    const { registry, register } = fixture();
    const record = { id: "reports", ...fields };
    register({ ...tab, ...descriptor }, record);
    expect(registry.controlUiDescriptors).toEqual([]);
    expectDiagnostic(registry, {
      level: "error",
      pluginId: record.id,
      ...(message ? { message: expect.stringContaining(message) } : {}),
    });
  });

  it("keeps the first plugin's tab when a later plugin claims its slug", () => {
    const { registry, register } = fixture();
    const slug = "a".repeat(64);
    for (const id of ["first", "later"]) {
      register({ ...tab, slug }, { id });
    }
    expect(
      registry.controlUiDescriptors.map(({ pluginId, descriptor }) => [pluginId, descriptor.slug]),
    ).toEqual([["first", slug]]);
    expect(registry.httpRoutes).toEqual([]);
    expectDiagnostic(registry, {
      level: "error",
      pluginId: "later",
      message: `control UI tab slug already registered by first: ${slug}`,
    });
  });

  it("keeps legacy flat descriptors loadable for shipped JavaScript plugins", () => {
    const { registerPlugin, expectDescriptor } = fixture();
    registerPlugin({ id: "legacy-descriptor-fixture" }, (api) =>
      api.registerControlUiDescriptor({
        id: "legacy-card",
        name: "Legacy Card",
        description: "Legacy descriptor from a JavaScript plugin",
      } as never),
    );
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
      group: "control",
      order: 5,
      requiredScopes: ["operator.read"],
    } satisfies PluginControlUiDescriptor;
    register(descriptor, { id: "workboard", origin: "bundled" });
    expectDescriptor("workboard", descriptor);
  });

  it("diagnoses UI declaration drift without rejecting registration", () => {
    const { registry, register, expectDescriptor } = fixture();
    register(
      { surface: "widget", id: "card", label: "Workboard card", requiredScopes: ["operator.read"] },
      { id: "workboard", uiCapabilities: [] },
    );
    expect(registry.diagnostics.filter(({ level }) => level === "warn")).toEqual([
      expect.objectContaining({
        pluginId: "workboard",
        message:
          'Registered UI capability "widget" is missing from uiCapabilities in openclaw.plugin.json.',
      }),
    ]);
    expectDescriptor("workboard", { id: "card", surface: "widget", label: "Workboard card" });
  });
});
