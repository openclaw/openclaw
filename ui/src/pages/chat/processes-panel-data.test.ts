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
  const data = new ProcessesPanelData(createContext(connection.gateway, sessions), vi.fn());
  onTestFinished(() => {
    data.dispose();
    sessions.dispose();
    disposeSidebarContextLifecycles();
    vi.useRealTimers();
  });
  const open = (sessionKey = key, presented = true) =>
    data.sync({ sessionKey, agentId: "main", presented });
  return { data, open, request, connection };
}

describe("process panel observation ownership", () => {
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
      expect(f.data.rows.map((row) => row.instanceId)).toEqual(["current"]);
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
    expect(f.data.rows).toEqual([]);
    f.open();
    await f.data.refresh();
    expect(f.data.rows[0]?.tail).toBe("Compiling");
  });

  it("rejects a stale Stop callback and pins the current process incarnation", async () => {
    let current = process();
    const f = fixture((method) =>
      method === "sessions.processes.list" ? page(current) : { requested: true },
    );
    f.open();
    await f.data.refresh();
    const previous = f.data.rows[0]!;
    current = process("replacement");
    await f.data.refresh();
    await f.data.stop(previous);
    expect(f.request.mock.calls.filter(([method]) => method === "sessions.processes.stop")).toEqual(
      [],
    );
    await f.data.stop(f.data.rows[0]!);
    expect(f.request).toHaveBeenCalledWith("sessions.processes.stop", {
      key,
      agentId: "main",
      sessionId: "parent-session",
      processId: "build",
      instanceId: "replacement",
    });
    expect(f.data.stopping.has("replacement")).toBe(true);
    current = { ...current, status: "killed", endedAt: 2, canStop: false };
    await f.data.refresh();
    expect(f.data.stopping.size).toBe(0);
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
    expect(f.data.rows).toEqual([]);
    expect(f.data.error).toContain("Access revoked");
    const count = f.request.mock.calls.length;
    await vi.advanceTimersByTimeAsync(15_000);
    expect(f.request).toHaveBeenCalledTimes(count);
  });
});
