import { describe, expect, it } from "vitest";
import type { PluginControlUiDescriptor } from "./host-hooks.js";
import { expectDiagnostic, registrationFixture } from "./registry-registration.test-support.js";

const tab = { surface: "tab", id: "panel", label: "Reports" } as const;
const invalidSlug = "descriptor slug requires";
const foreignRoute = "must be owned by its bundled plugin";
function fixture() {
  const { registry, register: registerPlugin } = registrationFixture();
  const register = (
    descriptor: PluginControlUiDescriptor,
    fields: Parameters<typeof registerPlugin>[0] = { id: "reports" },
  ) =>
    registerPlugin(fields, (api) => api.session.controls.registerControlUiDescriptor(descriptor));
  const expectDescriptor = (pluginId: string, descriptor: Partial<PluginControlUiDescriptor>) =>
    expect(registry.controlUiDescriptors).toMatchObject([{ pluginId, descriptor }]);
  return { registry, register, registerPlugin, expectDescriptor };
}

describe("plugin registry Control UI descriptors", () => {
  it.each([
    [{ slug: "api" }, {}, invalidSlug],
    [{ slug: "health" }, {}, invalidSlug],
    [{ slug: "reports", placement: "route:reports" }, { origin: "bundled" }, invalidSlug],
    [{ placement: "route:workboard" }, { id: "workboard", origin: "workspace" }, foreignRoute],
    [{ placement: "route:workboard" }, { id: "logbook", origin: "bundled" }, foreignRoute],
    [{ path: "//attacker.example/panel" }, {}, undefined],
    [{ path: "/\\attacker.example/panel" }, {}, undefined],
  ] as const)("rejects %j", (descriptor, fields, message) => {
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
    registerPlugin({ id: "legacy" }, (api) =>
      api.registerControlUiDescriptor({
        id: "legacy-card",
        name: "Legacy Card",
      } as never),
    );
    expectDescriptor("legacy", {
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
    expectDiagnostic(registry, {
      level: "warn",
      pluginId: "workboard",
      message: expect.stringContaining('UI capability "widget"'),
    });
    expectDescriptor("workboard", { id: "card", surface: "widget", label: "Workboard card" });
  });
});
