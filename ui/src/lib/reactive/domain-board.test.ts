import { describe, expect, it, onTestFinished, vi } from "vitest";
import type { GatewayEventFrame } from "../../api/gateway.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { EventStream, ValueSignal } from "../board/provider-signals.ts";
import { acquireBoardProviderForSession } from "../board/provider.ts";
import {
  projectBoardEvents,
  projectBoardProvider,
  projectBoardSession,
  projectBoardValue,
} from "./domain-board.ts";

describe("board projections", () => {
  it("projects an acquired provider without taking custody of its caller-owned lease", async () => {
    const sessionKey = "agent:main:caller-owned-projection";
    let revision = 0;
    const request = vi.fn(async (method: string) => {
      if (method !== "board.update") {
        throw new Error(`Unexpected method: ${method}`);
      }
      return { sessionKey, revision: ++revision, tabs: [], widgets: [] };
    });
    const stopTransport = vi.fn();
    const requestClient = createTestGatewayClient(request);
    const client = {
      request: <T = unknown>(...args: Parameters<typeof requestClient.request>) =>
        requestClient.request<T>(...args),
      addEventListener: vi.fn(() => stopTransport),
    };
    const lease = acquireBoardProviderForSession({ sessionKey }, client, false);
    onTestFinished(() => lease.release());
    const projection = projectBoardProvider(lease.provider);
    onTestFinished(() => projection.dispose());
    const changed = vi.fn();
    expect(projection.read().snapshot.revision).toBe(0);
    expect(projection.read().hasLoadedSnapshot).toBe(false);
    projection.subscribe(changed);
    await lease.provider.applyOps([]);
    expect(projection.read().snapshot.revision).toBe(1);
    expect(projection.read().hasLoadedSnapshot).toBe(true);
    expect(changed).toHaveBeenCalledOnce();

    projection.dispose();
    expect(stopTransport).not.toHaveBeenCalled();
    await lease.provider.applyOps([]);
    expect(lease.provider.snapshot$.value.revision).toBe(2);
    expect(projection.read().snapshot.revision).toBe(1);
    expect(changed).toHaveBeenCalledOnce();
    lease.release();
    expect(stopTransport).toHaveBeenCalledOnce();
    await expect(lease.provider.applyOps([])).rejects.toThrow();
  });

  it("keeps repeated mutable value publications and repeated events distinct", () => {
    const value = { count: 1 };
    const signal = new ValueSignal(value);
    const stream = new EventStream<string>();
    const state = projectBoardValue(signal);
    const events = projectBoardEvents(stream);
    onTestFinished(() => state.dispose());
    onTestFinished(() => events.dispose());
    const notify = vi.fn();
    const delivered = vi.fn();
    state.subscribe(notify);
    events.subscribe(delivered);
    expect(state.read().count).toBe(1);
    value.count = 2;
    signal.set(value);
    signal.set(value);
    stream.emit("refresh");
    stream.emit("refresh");
    expect(state.read()).toBe(value);
    expect(notify).toHaveBeenCalledTimes(2);
    expect(delivered.mock.calls).toEqual([["refresh"], ["refresh"]]);
    state.dispose();
    events.dispose();
    signal.set(value);
    stream.emit("refresh");
    expect(notify).toHaveBeenCalledTimes(2);
    expect(delivered).toHaveBeenCalledTimes(2);
  });

  it("shares one acquired transport between state and events and retires replaced scopes", () => {
    const makeClient = () => {
      const listeners = new Set<(event: GatewayEventFrame) => void>();
      return {
        request: vi.fn(async () => {
          throw new Error("Disconnected projection must not read");
        }),
        addEventListener: vi.fn((listener: (event: GatewayEventFrame) => void) => {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        }),
        listeners,
      };
    };
    const client = makeClient();
    const capabilities = {
      canMutate: true,
      canGrant: false,
      canPinWidgets: true,
      canPinMcpApps: false,
    };
    const source = {
      session: { sessionKey: "agent:main:projection" },
      client,
      connected: false,
      capabilities,
    };
    const projection = projectBoardSession(source);
    onTestFinished(() => projection.dispose());
    expect(projection.state.read().hasLoadedSnapshot).toBe(true);
    expect(client.addEventListener).not.toHaveBeenCalled();
    const stopState = projection.state.subscribe(() => {});
    const delivered = vi.fn();
    projection.events.subscribe(delivered);
    expect(client.addEventListener).toHaveBeenCalledOnce();
    expect(projection.state.read().canMutate).toBe(true);
    const readOnly = projectBoardSession({
      ...source,
      connected: true,
      capabilities: { ...capabilities, canMutate: false, canPinWidgets: false },
    });
    onTestFinished(() => readOnly.dispose());
    expect(readOnly.state.read().canMutate).toBe(false);
    readOnly.dispose();
    const emit = (listeners: typeof client.listeners) => {
      for (const listener of listeners) {
        listener({
          type: "event",
          event: "board.command",
          payload: {
            sessionKey: "agent:main:projection",
            command: { kind: "focus_tab", tabId: "main" },
          },
        });
      }
    };
    emit(client.listeners);
    expect(delivered).toHaveBeenCalledOnce();
    stopState();
    expect(client.listeners.size).toBe(1);
    const nextClient = makeClient();
    projection.replaceSource({ ...source, client: nextClient });
    expect(client.listeners.size).toBe(0);
    expect(nextClient.listeners.size).toBe(1);
    emit(client.listeners);
    expect(delivered).toHaveBeenCalledOnce();
    projection.dispose();
    expect(nextClient.listeners.size).toBe(0);
    expect(client.request).not.toHaveBeenCalled();
    expect(nextClient.request).not.toHaveBeenCalled();
  });
});
