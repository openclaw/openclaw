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
  const panel = createPanel();
  updatePanel(panel, {
    client: gateway.client,
    available: true,
    requestedSource: workstation.id,
    desktopClientFactory: () => ({ connect }),
    ...options,
  });
  await mountPanel(panel);
  return { gateway, connect, panel };
}

describe("Desktop native availability", () => {
  it("refreshes the same node after a DOM reconnect without accepting its old availability", async () => {
    let statusReply: Promise<EnvironmentSummary> = Promise.resolve(unlocked);
    const request = statusRequest(() => statusReply);
    const { gateway, connect, panel } = await mount(request, { documentMode: true });
    await waitForSolid(() => expect(connect).toHaveBeenCalledOnce());
    statusReply = Promise.resolve(workstation);
    refresh(gateway);
    await waitForSolid(() => expect(panel.textContent).toContain("This Mac is locked"));
    const oldStatus = createDeferred<EnvironmentSummary>();
    statusReply = oldStatus.promise;
    refresh(gateway);
    const oldStatusRequest = request.mock.results.at(-1)!.value;
    await unmountPanel(panel);
    expect(gateway.unsubscribe).toHaveBeenCalledOnce();
    const requestsAfterUnmount = request.mock.calls.length;
    refresh(gateway);
    expect(request).toHaveBeenCalledTimes(requestsAfterUnmount);
    statusReply = Promise.resolve(unlocked);
    await mountPanel(panel);
    await waitForSolid(() => expect(connect).toHaveBeenCalledTimes(2));
    expect(panel.textContent).not.toContain("This Mac is locked");
    oldStatus.resolve(workstation);
    await oldStatusRequest;
    await panel.updateComplete;
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

  it("rejects late availability replies from an older refresh, source, or Gateway", async () => {
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
    const releaseRefresh = hold();
    replies.set(workstation.id, Promise.resolve(unlocked));
    refresh(gateway);
    await waitForSolid(() => expect(panel.textContent).not.toContain("lock state is unknown"));
    await releaseRefresh();
    await panel.updateComplete;
    expect(panel.textContent).not.toContain("This Mac is locked");

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
