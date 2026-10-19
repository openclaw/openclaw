/* @vitest-environment jsdom */
import { describe, expect, it, onTestFinished, vi } from "vitest";
import type {
  SessionProcessSummary,
  SessionsProcessesListResult,
} from "../../../../packages/gateway-protocol/src/schema/session-processes.js";
import { createDeferred } from "../../../../test/helpers/promise.ts";
import { createTestSessionCapability } from "../../lib/sessions/session-capability.test-support.ts";
import { disposeSidebarContextLifecycles } from "../../test-helpers/app-sidebar-context-lifecycle.ts";
import { createContext, createGatewayHarness } from "../../test-helpers/app-sidebar.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import { ProcessesPanelData } from "./processes-panel-data.ts";

const key = "agent:main:parent";
function process(instanceId = "first"): SessionProcessSummary {
  return {
    processId: "build",
    instanceId,
    name: "npm run build",
    status: "running",
    startedAt: 1,
    tail: "Compiling",
    truncated: false,
    canStop: true,
  };
}
function page(row = process()): SessionsProcessesListResult {
  return { sessionId: "parent-session", processes: [row], truncated: false };
}
function fixture(read: (method: string, params: unknown) => unknown) {
  const request = vi.fn(read);
  const client = createTestGatewayClient(request);
  const connection = createGatewayHarness(client);
  connection.publish({
    hello: gatewayHelloForMethods(["sessions.processes.list", "sessions.processes.stop"]),
  });
  const sessions = createTestSessionCapability(connection.gateway);
  const context = createContext(connection.gateway, sessions);
  const panels: ProcessesPanelData[] = [];
  const addPanel = () => {
    const panel = new ProcessesPanelData(context, vi.fn());
    panels.push(panel);
    return panel;
  };
  const data = addPanel();
  onTestFinished(() => {
    panels.forEach((panel) => panel.dispose());
    sessions.dispose();
    disposeSidebarContextLifecycles();
    vi.useRealTimers();
  });
  const open = (sessionKey = key, presented = true) =>
    data.sync({ sessionKey, agentId: "main", presented });
  return { data, open, request, connection, addPanel };
}

describe("process panel observation ownership", () => {
  it("shares a live observation across visible panels and releases it with the last panel", async () => {
    vi.useFakeTimers();
    const first = createDeferred<SessionsProcessesListResult>();
    const f = fixture(() => first.promise);
    const second = f.addPanel();
    f.open();
    second.sync({ sessionKey: key, agentId: "main", presented: true });
    expect(f.request).toHaveBeenCalledTimes(1);
    first.resolve(page());
    await f.data.refresh();
    expect(second.snapshot.rows[0]?.tail).toBe("Compiling");
    const settled = f.addPanel();
    settled.sync({ sessionKey: key, agentId: "main", presented: true });
    expect(settled.snapshot.rows[0]?.tail).toBe("Compiling");
    expect(f.request).toHaveBeenCalledTimes(1);
    settled.dispose();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(f.request).toHaveBeenCalledTimes(13);
    f.open(key, false);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(f.request).toHaveBeenCalledTimes(14);
    second.dispose();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(f.request).toHaveBeenCalledTimes(14);
    f.open();
    await f.data.refresh();
    expect(f.request).toHaveBeenCalledTimes(15);
  });

  it("retires shared output while the document is hidden and catches up once on return", async () => {
    vi.useFakeTimers();
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    onTestFinished(() => visibility.mockRestore());
    const f = fixture(() => page());
    const second = f.addPanel();
    f.open();
    second.sync({ sessionKey: key, agentId: "main", presented: true });
    await f.data.refresh();
    visibility.mockReturnValue("hidden");
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(15_000);
    expect(f.request).toHaveBeenCalledTimes(1);
    expect(f.data.snapshot.rows).toEqual([]);
    expect(second.snapshot.rows).toEqual([]);
    visibility.mockReturnValue("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    await f.data.refresh();
    expect(f.request).toHaveBeenCalledTimes(2);
    expect(second.snapshot.rows[0]?.tail).toBe("Compiling");
  });

  it("keeps different sessions, agents and connections independent", async () => {
    vi.useFakeTimers();
    const f = fixture(() => page());
    f.open("global");
    const otherAgent = f.addPanel();
    otherAgent.sync({ sessionKey: "global", agentId: "other", presented: true });
    const otherSession = f.addPanel();
    otherSession.sync({ sessionKey: key, agentId: "main", presented: true });
    const otherConnection = fixture(() => page(process("other-connection")));
    otherConnection.open("global");
    await Promise.all([f.data.refresh(), otherConnection.data.refresh()]);
    expect(f.request).toHaveBeenCalledTimes(3);
    expect(otherConnection.request).toHaveBeenCalledTimes(1);
    expect(f.data.snapshot.rows[0]?.instanceId).toBe("first");
    expect(otherConnection.data.snapshot.rows[0]?.instanceId).toBe("other-connection");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(f.request).toHaveBeenCalledTimes(6);
    expect(otherConnection.request).toHaveBeenCalledTimes(2);
  });

  it.each(["parent", "connection"])(
    "rejects stale output after %s replacement",
    async (replacement) => {
      const old = createDeferred<SessionsProcessesListResult>();
      let reads = 0;
      const f = fixture(() => (++reads === 1 ? old.promise : page(process("current"))));
      f.open();
      if (replacement === "parent") {
        f.open("agent:main:other");
      } else {
        f.connection.publish({ phase: "reconnecting" });
        f.connection.publish({ phase: "connected" });
      }
      await f.data.refresh();
      old.resolve(page(process("retired")));
      await old.promise;
      expect(f.data.snapshot.rows.map((row) => row.instanceId)).toEqual(["current"]);
    },
  );

  it("refreshes only while visible without invoking process.poll", async () => {
    vi.useFakeTimers();
    const f = fixture(() => page());
    f.open();
    await f.data.refresh();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(f.request).toHaveBeenCalledTimes(2);
    expect(f.request.mock.calls.every(([method]) => method === "sessions.processes.list")).toBe(
      true,
    );
    f.open(key, false);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(f.request).toHaveBeenCalledTimes(2);
    expect(f.data.snapshot.rows).toEqual([]);
    f.open();
    await f.data.refresh();
    expect(f.data.snapshot.rows[0]?.tail).toBe("Compiling");
  });

  it("rejects a stale Stop callback and pins the current process incarnation", async () => {
    let current = process();
    const f = fixture((method) =>
      method === "sessions.processes.list" ? page(current) : { requested: true },
    );
    f.open();
    await f.data.refresh();
    const previous = f.data.snapshot.rows[0]!;
    current = process("replacement");
    await f.data.refresh();
    await f.data.stop(previous);
    expect(f.request.mock.calls.filter(([method]) => method === "sessions.processes.stop")).toEqual(
      [],
    );
    await f.data.stop(f.data.snapshot.rows[0]!);
    const second = f.addPanel();
    second.sync({ sessionKey: key, agentId: "main", presented: true });
    await second.stop(second.snapshot.rows[0]!);
    expect(
      f.request.mock.calls.filter(([method]) => method === "sessions.processes.stop"),
    ).toHaveLength(1);
    expect(f.request).toHaveBeenCalledWith("sessions.processes.stop", {
      key,
      agentId: "main",
      sessionId: "parent-session",
      processId: "build",
      instanceId: "replacement",
    });
    expect(f.data.snapshot.stopping.has("replacement")).toBe(true);
    current = { ...current, status: "killed", endedAt: 2, canStop: false };
    await f.data.refresh();
    expect(f.data.snapshot.stopping.size).toBe(0);
    expect(second.snapshot.rows[0]?.status).toBe("killed");
  });

  it("clears private output on access loss and waits for explicit retry", async () => {
    vi.useFakeTimers();
    let denied = false;
    const f = fixture(() => {
      if (denied) {
        throw new Error("Access revoked");
      }
      return page();
    });
    f.open();
    await f.data.refresh();
    denied = true;
    await f.data.refresh();
    expect(f.data.snapshot.rows).toEqual([]);
    expect(f.data.snapshot.error).toContain("Access revoked");
    const count = f.request.mock.calls.length;
    await vi.advanceTimersByTimeAsync(15_000);
    expect(f.request).toHaveBeenCalledTimes(count);
  });
});
