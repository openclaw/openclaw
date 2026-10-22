/* @vitest-environment jsdom */
import { GatewayProtocolRequestError } from "@openclaw/gateway-client/browser";
import { beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
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
beforeEach(() => vi.useFakeTimers());
const process = (instanceId = "first"): SessionProcessSummary => ({
  processId: "build",
  instanceId,
  name: "npm run build",
  status: "running",
  startedAt: 1,
  tail: "Compiling",
  truncated: false,
  canStop: true,
});
function page(row = process()): SessionsProcessesListResult {
  return { sessionId: "parent-session", processes: [row], truncated: false };
}
function fixture(read: (method: string, params: unknown) => unknown) {
  const request = vi.fn(read);
  const connection = createGatewayHarness(createTestGatewayClient(request));
  connection.publish({
    hello: gatewayHelloForMethods(["sessions.processes.list", "sessions.processes.stop"]),
  });
  const sessions = createTestSessionCapability(connection.gateway);
  const context = createContext(connection.gateway, sessions);
  const panels: ProcessesPanelData[] = [];
  const addPanel = (sessionKey?: string, agentId = "main") => {
    const panel = new ProcessesPanelData(context, vi.fn());
    panels.push(panel);
    if (sessionKey) {
      panel.sync({ sessionKey, agentId, presented: true });
    }
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
  const load = async (sessionKey = key) => {
    open(sessionKey);
    await data.refresh();
  };
  const advance = async (milliseconds: number, calls: number) => {
    await vi.advanceTimersByTimeAsync(milliseconds);
    expect(request).toHaveBeenCalledTimes(calls);
  };
  const stopCalls = () =>
    request.mock.calls.filter(([method]) => method === "sessions.processes.stop");
  return { data, open, load, advance, stopCalls, request, connection, addPanel };
}

describe("process panel observation ownership", () => {
  it("refreshes on owned process changes, retaining one change during an in-flight read", async () => {
    const stale = createDeferred<SessionsProcessesListResult>();
    let current = process();
    const f = fixture(() => (current.instanceId === "pending" ? stale.promise : page(current)));
    await f.load();
    const changed = (sessionKey = key, agentId = "main") =>
      f.connection.publishEvent("sessions.processes.changed", { sessionKey, agentId });
    changed("agent:other:parent", "other");
    await f.advance(59_000, 1);

    current = process("pending");
    changed();
    expect(f.request).toHaveBeenCalledTimes(2);
    current = { ...process(), status: "completed", tail: "Build complete", canStop: false };
    changed();
    changed();
    stale.resolve(page(process("pending")));
    await f.advance(0, 3);
    expect(f.data.snapshot.rows[0]?.tail).toBe("Build complete");
    f.open(key, false);
    changed();
    await f.advance(120_000, 3);
  });

  it("shares a live observation across visible panels and releases it with the last panel", async () => {
    const first = createDeferred<SessionsProcessesListResult>();
    const f = fixture(() => first.promise);
    f.open();
    const second = f.addPanel(key);
    expect(f.request).toHaveBeenCalledTimes(1);
    first.resolve(page());
    await f.data.refresh();
    expect(second.snapshot.rows[0]?.tail).toBe("Compiling");
    const settled = f.addPanel(key);
    expect(settled.snapshot.rows[0]?.tail).toBe("Compiling");
    expect(f.request).toHaveBeenCalledTimes(1);
    settled.dispose();
    await f.advance(60_000, 2);
    expect(f.request.mock.calls.every(([method]) => method === "sessions.processes.list")).toBe(
      true,
    );
    f.open(key, false);
    await f.advance(60_000, 3);
    second.dispose();
    await f.advance(60_000, 3);
    expect(f.data.snapshot.rows).toEqual([]);
    await f.load();
    expect(f.request).toHaveBeenCalledTimes(4);
    expect(f.data.snapshot.rows[0]?.tail).toBe("Compiling");
  });

  it("retires shared output while the document is hidden and catches up once on return", async () => {
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    onTestFinished(() => visibility.mockRestore());
    const f = fixture(() => page());
    f.open();
    const second = f.addPanel(key);
    await f.data.refresh();
    visibility.mockReturnValue("hidden");
    document.dispatchEvent(new Event("visibilitychange"));
    await f.advance(15_000, 1);
    expect(f.data.snapshot.rows).toEqual([]);
    expect(second.snapshot.rows).toEqual([]);
    visibility.mockReturnValue("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    await f.data.refresh();
    expect(f.request).toHaveBeenCalledTimes(2);
    expect(second.snapshot.rows[0]?.tail).toBe("Compiling");
  });

  it("keeps different sessions, agents and connections independent", async () => {
    const f = fixture(() => page());
    f.open("global");
    f.addPanel("global", "other");
    f.addPanel(key);
    const otherConnection = fixture(() => page(process("other-connection")));
    otherConnection.open("global");
    await Promise.all([f.data.refresh(), otherConnection.data.refresh()]);
    expect(f.request).toHaveBeenCalledTimes(3);
    expect(otherConnection.request).toHaveBeenCalledTimes(1);
    expect(f.data.snapshot.rows[0]?.instanceId).toBe("first");
    expect(otherConnection.data.snapshot.rows[0]?.instanceId).toBe("other-connection");
    await f.advance(60_000, 6);
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

  it("refreshes placement changes and rejects Stop callbacks for the previous process", async () => {
    let current = process();
    const f = fixture((method) =>
      method === "sessions.processes.list" ? page(current) : { requested: true },
    );
    await f.load();
    const previous = f.data.snapshot.rows[0]!;
    current = process("replacement");
    f.connection.publishEvent("sessions.changed", {
      reason: "placement",
      sessionKey: key,
      agentId: "main",
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(f.data.snapshot.rows[0]?.instanceId).toBe("replacement");
    await f.data.stop(previous);
    expect(f.stopCalls()).toEqual([]);
    await f.data.stop(f.data.snapshot.rows[0]!);
    const second = f.addPanel(key);
    await second.stop(second.snapshot.rows[0]!);
    expect(f.stopCalls()).toHaveLength(1);
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

  it.each([false, true])(
    "retains a valid result through transient failures and recovers its reads (empty: %s)",
    async (empty) => {
      const result = { ...page(), processes: empty ? [] : [process()] };
      let unavailable = false;
      const f = fixture(() => {
        if (unavailable) {
          throw new GatewayProtocolRequestError({
            code: "UNAVAILABLE",
            message: "Worker reconnecting",
          });
        }
        return result;
      });
      await f.load();
      const second = f.addPanel(key);
      unavailable = true;
      await f.data.refresh();
      expect(f.data.snapshot).toMatchObject({
        rows: result.processes,
        hasResult: true,
        error: "Worker reconnecting",
      });
      expect(second.snapshot.rows).toEqual(result.processes);
      unavailable = false;
      await f.advance(60_000, 3);
      expect(f.data.snapshot.error).toBeNull();
      unavailable = true;
      await f.data.refresh();
      unavailable = false;
      f.connection.publishEvent("sessions.processes.changed", { sessionKey: key, agentId: "main" });
      await f.advance(0, 5);
      expect(second.snapshot.error).toBeNull();
      expect(f.stopCalls()).toEqual([]);
    },
  );

  it("retains a failed Stop across an overlapping read until its process is known to be gone", async () => {
    const pending = createDeferred<SessionsProcessesListResult>();
    let reads = 0;
    let next = page();
    const f = fixture((method) => {
      if (method === "sessions.processes.stop") {
        throw new Error("Stop could not reach the worker");
      }
      return ++reads === 2 ? pending.promise : next;
    });
    await f.load();
    const refresh = f.data.refresh();
    await f.data.stop(f.data.snapshot.rows[0]!);
    pending.resolve(page());
    await refresh;
    expect(f.data.snapshot.error).toContain("Stop could not reach the worker");
    expect(f.data.snapshot.errorKind).toBe("action");
    next = { ...page(), processes: [], truncated: true };
    await f.advance(60_000, 4);
    expect(f.data.snapshot.errorKind).toBe("action");
    next = { ...next, truncated: false };
    await f.advance(60_000, 5);
    expect(f.data.snapshot.error).toBeNull();
    expect(f.stopCalls()).toHaveLength(1);
  });

  it.each([false, true])(
    "continues read observation after Stop is not accepted (unavailable: %s)",
    async (unavailable) => {
      const f = fixture((method) => {
        if (method === "sessions.processes.stop") {
          if (unavailable) {
            throw new GatewayProtocolRequestError({
              code: "UNAVAILABLE",
              message: "Worker reconnecting",
            });
          }
          return { requested: false };
        }
        return page();
      });
      await f.load();
      await f.data.stop(f.data.snapshot.rows[0]!);
      await f.advance(60_000, 3);
      expect(f.stopCalls()).toHaveLength(1);
      expect(f.data.snapshot.error).not.toBeNull();
      expect(f.data.snapshot.errorKind).toBe("action");
    },
  );

  it.each([false, true])(
    "reconciles read access after a rejected Stop without repeating it (read denied: %s)",
    async (readDenied) => {
      let stopped = false;
      const f = fixture((method) => {
        if (method === "sessions.processes.stop") {
          stopped = true;
          throw new GatewayProtocolRequestError({
            code: "FORBIDDEN",
            message: "Stop access changed",
          });
        }
        if (stopped && readDenied) {
          throw new GatewayProtocolRequestError({
            code: "FORBIDDEN",
            message: "Read access changed",
          });
        }
        return page({ ...process(), canStop: !stopped });
      });
      await f.load();
      const previous = f.data.snapshot.rows[0]!;
      await f.data.stop(previous);
      expect(f.data.snapshot.rows).toEqual(readDenied ? [] : [{ ...process(), canStop: false }]);
      await f.data.stop(previous);
      expect(f.stopCalls()).toHaveLength(1);
    },
  );

  it("clears private output on access loss and recovers after a sharing change", async () => {
    let denied = false;
    const f = fixture(() => {
      if (denied) {
        throw new GatewayProtocolRequestError({ code: "FORBIDDEN", message: "Access revoked" });
      }
      return page();
    });
    await f.load();
    const previous = f.data.snapshot.rows[0]!;
    denied = true;
    f.connection.publishEvent("sessions.changed", { reason: "sharing" });
    await vi.advanceTimersByTimeAsync(0);
    expect(f.data.snapshot.rows).toEqual([]);
    expect(f.data.snapshot.error).toContain("Access revoked");
    const processReads = () =>
      f.request.mock.calls.filter(([method]) => method === "sessions.processes.list").length;
    const count = processReads();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(processReads()).toBe(count);
    expect(f.data.snapshot.hasResult).toBe(false);
    await f.data.stop(previous);
    expect(f.stopCalls()).toEqual([]);
    denied = false;
    f.connection.publishEvent("sessions.changed", { reason: "sharing" });
    await vi.advanceTimersByTimeAsync(0);
    expect(f.data.snapshot.rows).toEqual([process()]);
  });
});
