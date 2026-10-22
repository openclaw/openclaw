/* @vitest-environment jsdom */

import type { EnvironmentSummary } from "@openclaw/gateway-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import type { DesktopClient } from "./desktop-client.ts";
import {
  createConnectionHandle,
  createGatewayClient,
  createPanel,
  mountDesktop,
  mountPanel,
  unmountPanel,
  updatePanel,
} from "./desktop-panel.test-support.ts";

const workstation: EnvironmentSummary = {
  id: "node:workstation",
  type: "node",
  status: "available",
  desktop: true,
  desktopAvailability: { state: "locked" },
};
const native = (state: "locked" | "unlocked" | "unknown", id = workstation.id) => ({
  ...workstation,
  id,
  desktopAvailability: { state },
});
const unlocked = native("unlocked");
const refresh = (
  gateway: ReturnType<typeof createGatewayClient>,
  nodeId: unknown = "workstation",
) => gateway.emit("node.runnerInventory.changed", { nodeId });

const observed = { transport: "rfb", wsPath: "/desktop/observe", control: false };
const statusRequest = (read: (params?: { environmentId?: string }) => unknown) =>
  vi.fn(async (method: string, params?: { environmentId?: string }) =>
    method === "environments.status" ? read(params) : observed,
  );

afterEach(() => document.body.replaceChildren());

async function mount(
  request: unknown,
  options: Partial<ReturnType<typeof createPanel>> = {},
  handle?: ReturnType<typeof createConnectionHandle>,
) {
  const gateway = createGatewayClient(request);
  const connect = vi.fn(async (connection: Parameters<DesktopClient["connect"]>[0]) => {
    connection.onConnect?.();
    return handle ?? createConnectionHandle();
  });
  const panel = await mountDesktop(gateway.client, connect, {
    requestedSource: workstation.id,
    ...options,
  });
  return { gateway, connect, panel };
}

describe("Desktop native availability", () => {
  it("refreshes the same node after a DOM reconnect", async () => {
    let statusReply: Promise<EnvironmentSummary> = Promise.resolve(unlocked);
    const request = statusRequest(() => statusReply);
    const { gateway, connect, panel } = await mount(request, { documentMode: true });
    await waitForSolid(() => expect(connect).toHaveBeenCalledOnce());
    statusReply = Promise.resolve(workstation);
    refresh(gateway);
    await waitForSolid(() => expect(panel.textContent).toContain("This Mac is locked"));
    await unmountPanel(panel);
    expect(gateway.unsubscribe).toHaveBeenCalledOnce();
    const requestsAfterUnmount = request.mock.calls.length;
    refresh(gateway);
    expect(request).toHaveBeenCalledTimes(requestsAfterUnmount);
    statusReply = Promise.resolve(unlocked);
    await mountPanel(panel);
    await waitForSolid(() => expect(connect).toHaveBeenCalledTimes(2));
    expect(panel.textContent).not.toContain("This Mac is locked");
  });

  it.each([false, true])(
    "keeps RFB available for normal login across lock changes (document=%s)",
    async (documentMode) => {
      let current = workstation;
      const request = vi.fn(async (method: string) => {
        if (method === "environments.list") {
          return { environments: [workstation] };
        }
        return method === "environments.status" ? current : observed;
      });
      const handle = createConnectionHandle();
      const { gateway, connect, panel } = await mount(
        request,
        { embedded: true, presented: true, documentMode },
        handle,
      );
      await waitForSolid(() => expect(connect).toHaveBeenCalledOnce());
      expect(panel.textContent).toContain("This Mac is locked");
      expect(panel.textContent).toContain("Sign in");

      const initialRequests = request.mock.calls.length;
      current = native("unknown");
      refresh(gateway);
      await waitForSolid(() => expect(panel.textContent).toContain("lock state is unknown"));
      gateway.emit("presence", { presence: [{ deviceId: "workstation", reason: "input" }] });
      refresh(gateway, "other");
      refresh(gateway, 1);
      await panel.updateComplete;
      expect(panel.textContent).toContain("lock state is unknown");

      current = unlocked;
      refresh(gateway);
      await waitForSolid(() => expect(panel.textContent).not.toContain("lock state is unknown"));
      expect(panel.textContent).not.toContain("This Mac is locked");
      expect(connect).toHaveBeenCalledOnce();
      expect(handle.disconnect).not.toHaveBeenCalled();
      expect(handle.disableInput).not.toHaveBeenCalled();
      expect(request.mock.calls.filter(([method]) => method === "desktop.observe")).toHaveLength(1);
      expect(request.mock.calls.slice(initialRequests)).toEqual([
        ["environments.status", { environmentId: workstation.id }],
        ["environments.status", { environmentId: workstation.id }],
      ]);
    },
  );

  it("rejects late availability replies from an older source or Gateway", async () => {
    const initialStatus = createDeferred<EnvironmentSummary>();
    const other = native("unlocked", "node:other");
    const replies = new Map<string, Promise<EnvironmentSummary>>([
      [workstation.id, Promise.resolve(native("unknown"))],
      [other.id, Promise.resolve(other)],
    ]);
    let firstStatus = true;
    const request = statusRequest((params) => {
      if (firstStatus) {
        firstStatus = false;
        return initialStatus.promise;
      }
      return replies.get(params?.environmentId ?? "");
    });
    const { gateway, connect, panel } = await mount(request, {
      embedded: true,
      presented: true,
      documentMode: true,
    });
    await waitForSolid(() => expect(request).toHaveBeenCalled());
    refresh(gateway);
    await request.mock.results.at(-1)!.value;
    await panel.updateComplete;
    initialStatus.resolve(workstation);
    await waitForSolid(() => expect(connect).toHaveBeenCalledOnce());
    expect(panel.textContent).toContain("lock state is unknown");

    const hold = (id = workstation.id) => {
      const reply = createDeferred<EnvironmentSummary>();
      replies.set(id, reply.promise);
      refresh(gateway, id.slice("node:".length));
      const requested = request.mock.results.at(-1)!.value;
      return async (value = workstation) => {
        reply.resolve(value);
        await requested;
      };
    };
    const releaseSource = hold();
    updatePanel(panel, { requestedSource: other.id });
    await waitForSolid(() => expect(connect).toHaveBeenCalledTimes(2));
    await releaseSource();
    refresh(gateway);
    await panel.updateComplete;
    expect(panel.textContent).not.toContain("This Mac is locked");
    expect(panel.textContent).not.toContain("lock state is unknown");

    const releaseGateway = hold(other.id);
    let replacementStatus = other;
    const replacement = createGatewayClient(statusRequest(() => replacementStatus));
    updatePanel(panel, { client: replacement.client });
    await waitForSolid(() => expect(connect).toHaveBeenCalledTimes(3));
    await releaseGateway(native("locked", other.id));
    refresh(gateway, "other");
    await panel.updateComplete;
    expect(panel.textContent).not.toContain("This Mac is locked");
    expect(connect).toHaveBeenCalledTimes(3);

    replacementStatus = native("locked", other.id);
    refresh(replacement, "other");
    await waitForSolid(() => expect(panel.textContent).toContain("This Mac is locked"));
    expect(connect).toHaveBeenCalledTimes(3);
  });
});

const UNAVAILABLE = "The requested desktop is unavailable. Retry when the machine is ready.";
const ENABLE = "Enable desktop access in OpenClaw";
const gatewayHost: EnvironmentSummary = {
  id: "gateway",
  type: "local",
  label: "Gateway local",
  status: "available",
  platform: "darwin",
};

async function mountHost(
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
  const { panel, connect } = await mount(request, {
    embedded: true,
    presented: true,
    sessionKey: "agent:main:local",
    requestedSource: environment.id,
    runtimeConfig,
  });
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
    const { panel, request, connect, button, runtimeConfig } = await mountHost(
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
    const { panel, request, connect, button, enable } = await mountHost(
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
    const { panel, button } = await mountHost(linuxHost, { state: "ready" }, false);
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
    const unavailableNode: EnvironmentSummary = {
      id: "node:workstation",
      type: "node",
      status: "available",
    };
    const { panel, request, button } = await mountHost(unavailableNode, { state: "ready" }, true);
    await waitForSolid(() => expect(panel.textContent).toContain(UNAVAILABLE));
    expect(button("Retry")).toBeDefined();
    expect(panel.textContent).not.toContain("Screen Sharing");
    expect(request.mock.calls.some(([, params]) => params && "includeDesktopSetup" in params)).toBe(
      false,
    );
  });

  it("shows the config error and stays on setup when enabling fails", async () => {
    const { panel, connect, button, runtimeConfig } = await mountHost(
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
    const { panel, button } = await mountHost(gatewayHost, new Error("setup check failed"), true);
    await waitForSolid(() => expect(panel.textContent).toContain(UNAVAILABLE));
    expect(button("Retry")).toBeDefined();
  });
});
