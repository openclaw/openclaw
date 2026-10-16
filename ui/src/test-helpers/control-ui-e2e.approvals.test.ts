/* @vitest-environment jsdom */
import { expect } from "vitest";
import {
  createControlUiMockGatewayInitScript,
  type ControlUiMockGateway,
} from "./control-ui-e2e.ts";
import { flushMockTimers, mockGatewayTest as it } from "./mock-gateway-page.test-support.ts";

it.for([
  { kind: "exec", resolve: "exec.approval.resolve" },
  { kind: "plugin", resolve: "plugin.approval.resolve" },
  { kind: "openclaw", resolve: "approval.resolve" },
  { kind: "plugin", resolve: "approval.resolve" },
])(
  "keeps $kind approval events and pending snapshots coherent through $resolve",
  async ({ kind, resolve }, { gatewayPage }) => {
    const { window, execute } = gatewayPage;
    execute(createControlUiMockGatewayInitScript());
    const gateway = (window as Window & { openclawControlUiE2eGateway?: ControlUiMockGateway })
      .openclawControlUiE2eGateway;
    if (!gateway) {
      throw new Error("Mock Gateway was not installed");
    }
    const { frames, send } = gatewayPage.connect();
    let sequence = 0;
    const request = async (method: string, params: unknown = {}) => {
      const id = `request-${++sequence}`;
      send(id, method, params);
      await flushMockTimers();
      return frames.find((frame) => frame.id === id)?.payload;
    };
    const approval = {
      id: "pending-approval",
      createdAtMs: Date.now(),
      expiresAtMs: Date.now() + 60_000,
      request: {
        command: "echo pending",
        title: "Pending action",
        description: "Review the action",
        proposalHash: "proposal-hash",
        sessionKey: "agent:main:main",
      },
    };
    const requested = `${kind}.approval.requested`;
    const list = `${kind}.approval.list`;
    const resolution = {
      id: approval.id,
      decision: "deny",
      ...(resolve === "approval.resolve"
        ? { kind: kind === "openclaw" ? "system-agent" : kind }
        : {}),
    };

    gateway.setRequestHandler("health", (pending) => {
      pending.emit(requested, approval);
      pending.respond({ ok: true });
    });
    await request("health");
    expect(await request(list)).toEqual([approval]);

    // Another approval namespace may reuse an opaque id without sharing its queue.
    const sibling = kind === "exec" ? "plugin" : "exec";
    gateway.emit(`${sibling}.approval.requested`, approval);
    gateway.deferNext(resolve);
    expect(await request(resolve, resolution)).toBeUndefined();
    expect(await request(list)).toEqual([approval]);
    gateway.rejectDeferred(resolve);
    expect(await request(list)).toEqual([approval]);

    gateway.deferNext(resolve);
    await request(resolve, resolution);
    gateway.resolveDeferred(resolve, { __mockError: { code: "UNAVAILABLE", message: "offline" } });
    expect(await request(list)).toEqual([approval]);

    gateway.deferNext(resolve);
    await request(resolve, resolution);
    gateway.resolveDeferred(resolve);
    expect(await request(list)).toEqual([]);
    expect(await request(`${sibling}.approval.list`)).toEqual([approval]);

    gateway.emit(requested, approval);
    await request(resolve, { ...resolution, decision: "allow-once" });
    expect(await request(list)).toEqual([]);

    gateway.emit(requested, approval);
    gateway.emit(`${kind}.approval.resolved`, { id: approval.id, decision: "deny" });
    expect(await request(list)).toEqual([]);
    gateway.emit(requested, { ...approval, expiresAtMs: Date.now() - 1 });
    expect(await request(list)).toEqual([]);

    gateway.emit(requested, approval);
    gateway.setMethodResponse(list, []);
    expect(await request(list)).toEqual([]);
  },
);
