/* @vitest-environment jsdom */
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, onTestFinished, vi } from "vitest";
import type { SessionsProcessesListResult } from "../../../../../packages/gateway-protocol/src/schema/session-processes.js";
import { createTestSessionCapability } from "../../../lib/sessions/session-capability.test-support.ts";
import { disposeSidebarContextLifecycles } from "../../../test-helpers/app-sidebar-context-lifecycle.ts";
import { createContext, createGatewayHarness } from "../../../test-helpers/app-sidebar.ts";
import { createApplicationContextProvider } from "../../../test-helpers/application-context.ts";
import { createTestGatewayClient } from "../../../test-helpers/gateway-client.ts";
import { gatewayHelloForMethods } from "../../../test-helpers/gateway-methods.ts";
import "./chat-details-session.tsx";
import "./chat-processes-panel.tsx";

it.each([false, true])(
  "distinguishes a retired process from an incomplete list (truncated: %s)",
  async (truncated) => {
    vi.useFakeTimers();
    let result: SessionsProcessesListResult = {
      sessionId: "parent-session",
      truncated: false,
      processes: [
        {
          processId: "build",
          instanceId: "build-instance",
          name: "Build app",
          status: "running",
          startedAt: 1,
          tail: "Compiling",
          truncated: false,
          canStop: false,
        },
      ],
    };
    const client = createTestGatewayClient(() => result);
    const connection = createGatewayHarness(client);
    connection.publish({
      hello: gatewayHelloForMethods(["sessions.processes.list", "sessions.processes.stop"]),
    });
    const sessions = createTestSessionCapability(connection.gateway);
    const provider = createApplicationContextProvider(createContext(connection.gateway, sessions));
    const panel = document.createElement("openclaw-chat-processes-panel");
    panel.sessionKey = "agent:main:parent";
    provider.append(panel);
    document.body.append(provider);
    onTestFinished(() => {
      provider.remove();
      sessions.dispose();
      disposeSidebarContextLifecycles();
      vi.useRealTimers();
    });
    await panel.updateComplete;
    await vi.advanceTimersByTimeAsync(0);
    await panel.updateComplete;
    panel.querySelector<HTMLButtonElement>(".chat-processes__open")!.click();
    await panel.updateComplete;
    expect(panel.textContent).toContain("Compiling");
    result = { sessionId: "parent-session", processes: [], truncated };
    connection.publishEvent("sessions.processes.changed", {
      sessionKey: "agent:main:parent",
      agentId: "main",
    });
    await vi.advanceTimersByTimeAsync(0);
    await panel.updateComplete;
    if (truncated) {
      expect(panel.textContent).toContain("limited list");
      expect(panel.textContent).not.toContain("no longer retained");
    } else {
      expect(panel.textContent).toContain("no longer retained");
    }
  },
);

it("retires stop authority immediately and reads the complete replacement scope", async () => {
  vi.useFakeTimers();
  const request = vi.fn((method: string, params?: unknown) => {
    if (method === "sessions.processes.stop") {
      return { requested: true };
    }
    const target = asOptionalRecord(params);
    return {
      sessionId: target?.key === "global" ? "worker-session" : "parent-session",
      truncated: false,
      processes:
        target?.key === "global"
          ? []
          : [
              {
                processId: "build",
                instanceId: "build-instance",
                name: "Build app",
                status: "running",
                startedAt: 1,
                tail: "Compiling",
                truncated: false,
                canStop: true,
              },
            ],
    } satisfies SessionsProcessesListResult;
  });
  const connection = createGatewayHarness(createTestGatewayClient(request));
  connection.publish({
    hello: gatewayHelloForMethods(["sessions.processes.list", "sessions.processes.stop"]),
  });
  const sessions = createTestSessionCapability(connection.gateway);
  const provider = createApplicationContextProvider(createContext(connection.gateway, sessions));
  const panel = document.createElement("openclaw-chat-processes-panel");
  panel.sessionKey = "agent:main:parent";
  provider.append(panel);
  document.body.append(provider);
  onTestFinished(() => {
    provider.remove();
    sessions.dispose();
    disposeSidebarContextLifecycles();
    vi.useRealTimers();
  });
  await panel.updateComplete;
  await vi.advanceTimersByTimeAsync(0);
  const stop = panel.querySelector<HTMLButtonElement>(".chat-processes__stop")!;
  expect(stop.disabled).toBe(false);

  panel.sessionKey = "global";
  panel.agentId = "worker";
  stop.click();
  expect(request.mock.calls.filter(([method]) => method === "sessions.processes.stop")).toEqual([]);
  await panel.updateComplete;
  await vi.advanceTimersByTimeAsync(0);
  expect(request.mock.calls.filter(([method]) => method === "sessions.processes.list")).toEqual([
    ["sessions.processes.list", { key: "agent:main:parent", agentId: "main" }],
    ["sessions.processes.list", { key: "global", agentId: "worker" }],
  ]);
});

it("keeps details process observation through refreshes and follows its presented scope", async () => {
  vi.useFakeTimers();
  const request = vi.fn((method: string, params?: unknown) => {
    expect(method).toBe("sessions.processes.list");
    const target = asOptionalRecord(params);
    return {
      sessionId: target?.key === "global" ? "worker-session" : "parent-session",
      truncated: false,
      processes: [
        {
          processId: "build",
          instanceId: "build-instance",
          name: target?.agentId === "worker" ? "Worker build" : "Main build",
          status: "running",
          startedAt: 1,
          tail: "Compiling",
          truncated: false,
          canStop: false,
        },
      ],
    } satisfies SessionsProcessesListResult;
  });
  const connection = createGatewayHarness(createTestGatewayClient(request));
  connection.publish({ hello: gatewayHelloForMethods(["sessions.processes.list"]) });
  const sessions = createTestSessionCapability(connection.gateway);
  const provider = createApplicationContextProvider(createContext(connection.gateway, sessions));
  const details = document.createElement("openclaw-chat-details-session");
  details.props = {
    sessionKey: "agent:main:parent",
    currentAgentId: "main",
    selectedSession: undefined,
    messages: [],
    onOpenProcesses: () => {},
  };
  details.presented = true;
  provider.append(details);
  document.body.append(provider);
  onTestFinished(() => {
    provider.remove();
    sessions.dispose();
    disposeSidebarContextLifecycles();
    vi.useRealTimers();
  });
  await details.updateComplete;
  await vi.advanceTimersByTimeAsync(0);
  const row = details.querySelector(".chat-details__process");
  expect(row?.textContent).toContain("Main build");
  expect(request.mock.calls).toEqual([
    ["sessions.processes.list", { key: "agent:main:parent", agentId: "main" }],
  ]);

  details.props = { ...details.props!, messages: [] };
  await details.updateComplete;
  await vi.advanceTimersByTimeAsync(0);
  expect(details.querySelector(".chat-details__process")).toBe(row);
  expect(request).toHaveBeenCalledOnce();

  details.props = { ...details.props!, sessionKey: "global", currentAgentId: "worker" };
  await details.updateComplete;
  await vi.advanceTimersByTimeAsync(0);
  expect(request.mock.calls).toEqual([
    ["sessions.processes.list", { key: "agent:main:parent", agentId: "main" }],
    ["sessions.processes.list", { key: "global", agentId: "worker" }],
  ]);
  expect(details.querySelector(".chat-details__process")?.textContent).toContain("Worker build");

  details.presented = false;
  details.props = { ...details.props!, sessionKey: "agent:main:parent", currentAgentId: "main" };
  await details.updateComplete;
  await vi.advanceTimersByTimeAsync(5_000);
  expect(request).toHaveBeenCalledTimes(2);

  details.presented = true;
  await details.updateComplete;
  await vi.advanceTimersByTimeAsync(0);
  expect(request.mock.calls.at(-1)).toEqual([
    "sessions.processes.list",
    { key: "agent:main:parent", agentId: "main" },
  ]);
  expect(request).toHaveBeenCalledTimes(3);
  expect(details.querySelector(".chat-details__process")?.textContent).toContain("Main build");
});
