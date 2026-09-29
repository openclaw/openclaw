/* @vitest-environment jsdom */

import type { EnvironmentSummary } from "@openclaw/gateway-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import type { DesktopClient } from "./desktop-client.ts";
import {
  createConnectionHandle,
  createGatewayClient,
  createPanel,
  settleTasks,
} from "./desktop-panel.test-support.ts";

const workstation: EnvironmentSummary = {
  id: "node:workstation",
  type: "node",
  status: "available",
  desktop: true,
  desktopAvailability: { state: "locked" },
};

const observed = {
  transport: "rfb",
  wsPath: "/desktop/observe?token=synthetic",
  expiresAtMs: 60_000,
  control: false,
};

afterEach(() => document.body.replaceChildren());

describe("Desktop native availability", () => {
  it("refreshes the same node after a DOM reconnect without accepting its old availability", async () => {
    const unlocked: EnvironmentSummary = {
      ...workstation,
      desktopAvailability: { state: "unlocked" },
    };
    let statusReply = Promise.resolve(unlocked);
    const gateway = createGatewayClient(
      vi.fn(async (method: string) => (method === "environments.status" ? statusReply : observed)),
    );
    const connect = vi.fn(async (options: Parameters<DesktopClient["connect"]>[0]) => {
      options.onConnect?.();
      return createConnectionHandle();
    });
    const panel = createPanel();
    Object.assign(panel, {
      client: gateway.client,
      available: true,
      documentMode: true,
      requestedSource: workstation.id,
      desktopClientFactory: () => ({ connect }),
    });
    document.body.append(panel);
    await waitForFast(() => expect(connect).toHaveBeenCalledOnce());
    statusReply = Promise.resolve(workstation);
    gateway.emit("node.runnerInventory.changed", { nodeId: "workstation" });
    await waitForFast(() => expect(panel.renderRoot.textContent).toContain("This Mac is locked"));
    const oldStatus = createDeferred<EnvironmentSummary>();
    statusReply = oldStatus.promise;
    gateway.emit("node.runnerInventory.changed", { nodeId: "workstation" });
    panel.remove();
    statusReply = Promise.resolve(unlocked);
    document.body.append(panel);
    await waitForFast(() => expect(connect).toHaveBeenCalledTimes(2));
    expect(panel.renderRoot.textContent).not.toContain("This Mac is locked");
    oldStatus.resolve(workstation);
    await settleTasks();
    expect(panel.renderRoot.textContent).not.toContain("This Mac is locked");
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
      const gateway = createGatewayClient(request);
      const handle = createConnectionHandle();
      const connect = vi.fn(async (options: Parameters<DesktopClient["connect"]>[0]) => {
        options.onConnect?.();
        return handle;
      });
      const panel = createPanel();
      Object.assign(panel, {
        client: gateway.client,
        available: true,
        embedded: true,
        presented: true,
        documentMode,
        requestedSource: workstation.id,
        desktopClientFactory: () => ({ connect }),
      });
      document.body.append(panel);
      await waitForFast(() => expect(connect).toHaveBeenCalledOnce());
      expect(panel.renderRoot.textContent).toContain("This Mac is locked");
      expect(panel.renderRoot.textContent).toContain("Sign in");

      const initialRequests = request.mock.calls.length;
      current = { ...workstation, desktopAvailability: { state: "unknown" } };
      gateway.emit("node.runnerInventory.changed", { nodeId: "workstation" });
      await waitForFast(() =>
        expect(panel.renderRoot.textContent).toContain("lock state is unknown"),
      );
      gateway.emit("presence", { presence: [{ deviceId: "workstation", reason: "input" }] });
      gateway.emit("node.runnerInventory.changed", { nodeId: "other" });
      gateway.emit("node.runnerInventory.changed", { nodeId: 1 });
      await settleTasks();
      expect(panel.renderRoot.textContent).toContain("lock state is unknown");

      current = { ...workstation, desktopAvailability: { state: "unlocked" } };
      gateway.emit("node.runnerInventory.changed", { nodeId: "workstation" });
      await waitForFast(() =>
        expect(panel.renderRoot.textContent).not.toContain("lock state is unknown"),
      );
      expect(panel.renderRoot.textContent).not.toContain("This Mac is locked");
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
    const other: EnvironmentSummary = {
      ...workstation,
      id: "node:other",
      desktopAvailability: { state: "unlocked" },
    };
    const replies = new Map<string, Promise<EnvironmentSummary>>([
      [
        workstation.id,
        Promise.resolve({ ...workstation, desktopAvailability: { state: "unknown" } }),
      ],
      [other.id, Promise.resolve(other)],
    ]);
    let firstStatus = true;
    const request = vi.fn(async (method: string, params?: { environmentId?: string }) => {
      if (method === "environments.status") {
        if (firstStatus) {
          firstStatus = false;
          return initialStatus.promise;
        }
        return replies.get(params?.environmentId ?? "");
      }
      return observed;
    });
    const gateway = createGatewayClient(request);
    const connect = vi.fn(async (options: Parameters<DesktopClient["connect"]>[0]) => {
      options.onConnect?.();
      return createConnectionHandle();
    });
    const panel = createPanel();
    Object.assign(panel, {
      client: gateway.client,
      available: true,
      embedded: true,
      presented: true,
      documentMode: true,
      requestedSource: workstation.id,
      desktopClientFactory: () => ({ connect }),
    });
    document.body.append(panel);
    await waitForFast(() => expect(request).toHaveBeenCalled());
    gateway.emit("node.runnerInventory.changed", { nodeId: "workstation" });
    await settleTasks();
    initialStatus.resolve(workstation);
    await waitForFast(() => expect(connect).toHaveBeenCalledOnce());
    expect(panel.renderRoot.textContent).toContain("lock state is unknown");

    const oldRefresh = createDeferred<EnvironmentSummary>();
    replies.set(workstation.id, oldRefresh.promise);
    gateway.emit("node.runnerInventory.changed", { nodeId: "workstation" });
    replies.set(
      workstation.id,
      Promise.resolve({ ...workstation, desktopAvailability: { state: "unlocked" } }),
    );
    gateway.emit("node.runnerInventory.changed", { nodeId: "workstation" });
    await waitForFast(() =>
      expect(panel.renderRoot.textContent).not.toContain("lock state is unknown"),
    );
    oldRefresh.resolve(workstation);
    await settleTasks();
    expect(panel.renderRoot.textContent).not.toContain("This Mac is locked");

    const oldSource = createDeferred<EnvironmentSummary>();
    replies.set(workstation.id, oldSource.promise);
    gateway.emit("node.runnerInventory.changed", { nodeId: "workstation" });
    panel.requestedSource = other.id;
    await waitForFast(() => expect(connect).toHaveBeenCalledTimes(2));
    oldSource.resolve(workstation);
    gateway.emit("node.runnerInventory.changed", { nodeId: "workstation" });
    await settleTasks();
    expect(panel.renderRoot.textContent).not.toContain("This Mac is locked");
    expect(panel.renderRoot.textContent).not.toContain("lock state is unknown");

    const oldGateway = createDeferred<EnvironmentSummary>();
    replies.set(other.id, oldGateway.promise);
    gateway.emit("node.runnerInventory.changed", { nodeId: "other" });
    const replacement = createGatewayClient(
      vi.fn(async (method: string) => (method === "environments.status" ? other : observed)),
    );
    panel.client = replacement.client;
    await waitForFast(() => expect(connect).toHaveBeenCalledTimes(3));
    oldGateway.resolve({ ...other, desktopAvailability: { state: "locked" } });
    gateway.emit("node.runnerInventory.changed", { nodeId: "other" });
    await settleTasks();
    expect(panel.renderRoot.textContent).not.toContain("This Mac is locked");
    expect(connect).toHaveBeenCalledTimes(3);
  });
});
