/* @vitest-environment jsdom */

import type { EnvironmentSummary } from "@openclaw/gateway-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import type { DesktopClient } from "./desktop-client.ts";
import {
  createConnectionHandle,
  createGatewayClient,
  createPanel,
  mountPanel,
  updatePanel,
} from "./desktop-panel.test-support.ts";

const UNAVAILABLE = "The requested desktop is unavailable. Retry when the machine is ready.";
const ENABLE = "Enable desktop access in OpenClaw";
const gatewayHost: EnvironmentSummary = {
  id: "gateway",
  type: "local",
  label: "Gateway local",
  status: "available",
  platform: "darwin",
};
const observed = { transport: "rfb", wsPath: "/desktop/observe", control: false };

afterEach(() => document.body.replaceChildren());

async function mount(
  environment: EnvironmentSummary,
  desktopSetup: { state: string } | Error,
  canPatch: boolean,
) {
  let current: EnvironmentSummary = environment;
  const runtimeConfig = {
    canPatch,
    state: { lastError: null as string | null },
    ensureLoaded: vi.fn(async () => {}),
    patch: vi.fn(async () => {
      current = { ...current, desktop: true };
      return true;
    }),
  };
  const request = vi.fn(async (method: string, params?: { includeDesktopSetup?: boolean }) => {
    if (method === "environments.status") {
      return current;
    }
    if (method === "environments.list") {
      if (desktopSetup instanceof Error) {
        throw desktopSetup;
      }
      return {
        environments: [params?.includeDesktopSetup ? { ...current, desktopSetup } : current],
      };
    }
    return observed;
  });
  const gateway = createGatewayClient(request);
  const connect = vi.fn(async (connection: Parameters<DesktopClient["connect"]>[0]) => {
    connection.onConnect?.();
    return createConnectionHandle();
  });
  const panel = createPanel();
  updatePanel(panel, {
    client: gateway.client,
    available: true,
    embedded: true,
    presented: true,
    sessionKey: "agent:main:local",
    requestedSource: environment.id,
    desktopClientFactory: () => ({ connect }),
    runtimeConfig,
  });
  await mountPanel(panel);
  const button = (name: string) =>
    Array.from(panel.querySelectorAll("button")).find(
      (entry) => (entry.getAttribute("aria-label") ?? entry.textContent)?.trim() === name,
    );
  return {
    runtimeConfig,
    panel,
    request,
    connect,
    button,
    enable: () => (current = { ...current, desktop: true }),
  };
}

const observeHost = (request: ReturnType<typeof vi.fn>) =>
  request.mock.calls.filter(
    ([method, params]) => method === "desktop.observe" && params?.source?.kind === "host",
  );

describe("Desktop host setup guidance", () => {
  it("offers to enable Host Desktop and connects afterwards", async () => {
    const { panel, request, connect, button, runtimeConfig } = await mount(
      gatewayHost,
      { state: "ready" },
      true,
    );
    await waitForSolid(() => expect(panel.textContent).toContain("Screen Sharing is available"));
    expect(panel.textContent).toContain("Desktop access is not enabled on the Gateway host.");
    expect(panel.textContent).toContain("shares the Gateway host's screen");
    expect(panel.textContent).toContain(
      "Enable desktop access to view and control the Gateway host in OpenClaw.",
    );
    expect(panel.textContent).toContain("macOS user account on the Gateway host");
    expect(panel.textContent).toContain("Applies without restarting the Gateway.");
    expect(panel.textContent).toContain("reachable from other devices on your network");
    expect(panel.textContent).not.toContain(UNAVAILABLE);
    expect(request).toHaveBeenCalledWith("environments.list", { includeDesktopSetup: true });
    expect(connect).not.toHaveBeenCalled();

    button(ENABLE)?.click();
    await waitForSolid(() => expect(connect).toHaveBeenCalledOnce());
    expect(runtimeConfig.patch).toHaveBeenCalledOnce();
    expect(runtimeConfig.patch).toHaveBeenCalledWith(
      expect.objectContaining({ raw: { desktop: { host: { enabled: true } } } }),
    );
    expect(observeHost(request)).toHaveLength(1);
  });

  it("re-reads inventory on Check again when Screen Sharing needs a server", async () => {
    const { panel, request, connect, button, enable } = await mount(
      gatewayHost,
      { state: "needs-server" },
      false,
    );
    await waitForSolid(() => expect(panel.textContent).toContain("Turn on Screen Sharing"));
    expect(panel.textContent).toContain("On the Gateway host Mac, open System Settings");
    expect(panel.textContent).toContain("allow the Gateway host account to Observe and Control");
    expect(panel.textContent).not.toContain("On this Mac");
    expect(panel.textContent).toContain("reachable from other devices on your network");
    expect(panel.textContent).not.toContain(UNAVAILABLE);
    expect(button(ENABLE)).toBeUndefined();
    expect(connect).not.toHaveBeenCalled();

    enable();
    button("Check again")?.click();
    await waitForSolid(() => expect(connect).toHaveBeenCalledOnce());
    expect(observeHost(request)).toHaveLength(1);
  });

  it("points to an administrator when this connection cannot patch config", async () => {
    const linuxHost = { ...gatewayHost, platform: "linux" };
    const { panel, button } = await mount(linuxHost, { state: "ready" }, false);
    await waitForSolid(() => expect(panel.textContent).toContain("A desktop is available"));
    expect(panel.textContent).toContain("desktop server on the Gateway host uses its own password");
    expect(panel.textContent).toContain(
      "The desktop server may be reachable from other devices on your network.",
    );
    expect(panel.textContent).toContain("A Gateway administrator can enable desktop access.");
    expect(panel.textContent).not.toContain(UNAVAILABLE);
    expect(button(ENABLE)?.disabled).toBe(true);
    expect(button("Check again")).toBeDefined();
  });

  it("keeps the generic notice for non-gateway targets without asking for setup", async () => {
    const workstation: EnvironmentSummary = {
      id: "node:workstation",
      type: "node",
      status: "available",
    };
    const { panel, request, button } = await mount(workstation, { state: "ready" }, true);
    await waitForSolid(() => expect(panel.textContent).toContain(UNAVAILABLE));
    expect(button("Retry")).toBeDefined();
    expect(panel.textContent).not.toContain("Screen Sharing");
    expect(request.mock.calls.some(([, params]) => params && "includeDesktopSetup" in params)).toBe(
      false,
    );
  });

  it("shows the config error and stays on setup when enabling fails", async () => {
    const { panel, connect, button, runtimeConfig } = await mount(
      gatewayHost,
      { state: "ready" },
      true,
    );
    runtimeConfig.patch.mockResolvedValueOnce(false);
    runtimeConfig.state.lastError = "Config write rejected.";
    await waitForSolid(() => expect(button(ENABLE)).toBeDefined());
    button(ENABLE)?.click();
    await waitForSolid(() =>
      expect(panel.querySelector('[role="alert"]')?.textContent).toBe("Config write rejected."),
    );
    expect(button(ENABLE)?.disabled).toBe(false);
    expect(connect).not.toHaveBeenCalled();
  });

  it("keeps the generic notice when the setup check fails", async () => {
    const { panel, button } = await mount(gatewayHost, new Error("setup check failed"), true);
    await waitForSolid(() => expect(panel.textContent).toContain(UNAVAILABLE));
    expect(button("Retry")).toBeDefined();
  });
});
