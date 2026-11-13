// @vitest-environment jsdom
import { expect, it, onTestFinished, vi } from "vitest";
import { createRuntimeConfigCapability } from "../../lib/config/runtime-config-capability.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { createSolidApplicationContextProvider } from "../../test-helpers/solid-application-context.tsx";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import { PersonalRolePreview } from "./personal-role-preview.tsx";
import { createConnectedContext } from "./profile-page.test-support.tsx";

function mountPreview(applied: Record<string, unknown>) {
  const request = vi.fn().mockResolvedValue({
    exists: true,
    valid: true,
    hash: "synthetic",
    config: applied,
    runtimeConfig: applied,
  });
  const harness = createConnectedContext(request);
  harness.emitHello(gatewayHelloForMethods(["config.get"]));
  const runtimeConfig = createRuntimeConfigCapability(harness.context.gateway);
  const provider = createSolidApplicationContextProvider({ ...harness.context, runtimeConfig });
  const view = mountSolid(() => <PersonalRolePreview ceiling={["operator.write"]} />, {
    wrapper: provider.wrapper,
  });
  onTestFinished(() => {
    view.unmount();
    runtimeConfig.dispose();
  });
  return { view, harness, request, runtimeConfig };
}

it("loads applied default-role policy only for an admin preview and intersects the supplied approval ceiling", async () => {
  const applied = {
    gateway: {
      roles: { default: "guest", definitions: { guest: { scopes: ["operator.sessions.read"] } } },
    },
  };
  const { view, harness, request } = mountPreview(applied);
  await waitForSolid(() =>
    expect(view.container.textContent).toContain(
      "Default local role: guest. Operator scope policy: operator.sessions.read.",
    ),
  );
  expect(view.container.textContent).toContain(
    "Combined operator scope ceiling: operator.sessions.read.",
  );
  expect(request.mock.calls.map(([method]) => method)).toEqual(["config.get"]);
  harness.emitHello(gatewayHelloForMethods(["config.get"], ["operator.read"]));
  await waitForSolid(() =>
    expect(view.container.textContent).not.toContain("Default local role: guest"),
  );
  expect(request).toHaveBeenCalledTimes(1);
});

it.each([{}, { roles: { definitions: { guest: { scopes: ["operator.read"] } } } }])(
  "distinguishes disabled enforcement from an unreported applied projection: %j",
  async (gateway) => {
    const applied = { gateway };
    const { view, request, runtimeConfig } = mountPreview(applied);
    await waitForSolid(() =>
      expect(view.container.textContent).toContain("No additional role policy is configured."),
    );
    expect(view.container.textContent).toContain(
      "Available device/setup scope ceiling: operator.write.",
    );
    expect(view.container.textContent).not.toContain(
      "Default role policy is not currently reported",
    );
    request.mockResolvedValueOnce({ exists: true, valid: true, hash: "partial", config: applied });
    await runtimeConfig.refreshDisplay();
    await waitForSolid(() =>
      expect(view.container.textContent).toContain("Default role policy is not currently reported"),
    );
    expect(view.container.textContent).not.toContain("No additional role policy is configured.");
  },
);
