/* @vitest-environment jsdom */
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, onTestFinished, vi } from "vitest";
import type { SessionsProcessesListResult } from "../../../../../packages/gateway-protocol/src/schema/session-processes.js";
import { createDeferred } from "../../../../../test/helpers/promise.js";
import { createTestSessionCapability } from "../../../lib/sessions/session-capability.test-support.ts";
import { disposeSidebarContextLifecycles } from "../../../test-helpers/app-sidebar-context-lifecycle.ts";
import { createContext, createGatewayHarness } from "../../../test-helpers/app-sidebar.ts";
import { createApplicationContextProvider } from "../../../test-helpers/application-context.ts";
import { createTestGatewayClient } from "../../../test-helpers/gateway-client.ts";
import { gatewayHelloForMethods } from "../../../test-helpers/gateway-methods.ts";
import { waitForSolid } from "../../../test-helpers/solid-settle.ts";
import "./chat-details-session.tsx";
import "./chat-processes-panel.tsx";

const mainRead = ["sessions.processes.list", { key: "agent:main:parent", agentId: "main" }];
const workerRead = ["sessions.processes.list", { key: "global", agentId: "worker" }];
const completeList = { sessionId: "parent-session", truncated: false };

function process(overrides: Partial<SessionsProcessesListResult["processes"][number]> = {}) {
  return {
    processId: "build",
    instanceId: "build-instance",
    name: "Build app",
    status: "running" as const,
    startedAt: 1,
    tail: "Compiling",
    truncated: false,
    canStop: false,
    ...overrides,
  };
}

function mountProcesses(
  request: Parameters<typeof createTestGatewayClient>[0],
  methods = ["sessions.processes.list", "sessions.processes.stop"],
) {
  vi.useFakeTimers();
  const connection = createGatewayHarness(createTestGatewayClient(request));
  connection.publish({ hello: gatewayHelloForMethods(methods) });
  const sessions = createTestSessionCapability(connection.gateway);
  const provider = createApplicationContextProvider(createContext(connection.gateway, sessions));
  onTestFinished(() => {
    provider.remove();
    sessions.dispose();
    disposeSidebarContextLifecycles();
    vi.useRealTimers();
  });
  return {
    connection,
    mount: (element: HTMLElement) => {
      provider.append(element);
      document.body.append(provider);
    },
  };
}

async function settle(element: { updateComplete: Promise<unknown> }, ms: number) {
  await element.updateComplete;
  await vi.advanceTimersByTimeAsync(ms);
}

it.each([false, true])("distinguishes retired vs unlisted (truncated: %s)", async (truncated) => {
  let result: SessionsProcessesListResult = { ...completeList, processes: [process()] };
  const { connection, mount } = mountProcesses(() => result);
  const panel = document.createElement("openclaw-chat-processes-panel");
  panel.sessionKey = "agent:main:parent";
  mount(panel);

  await settle(panel, 0);
  await panel.updateComplete;
  panel.querySelector<HTMLButtonElement>(".chat-processes__open")!.click();
  await panel.updateComplete;
  expect(panel.textContent).toContain("Compiling");
  result = { ...result, processes: [{ ...result.processes[0]!, tail: "" }] };
  connection.publishEvent("sessions.processes.changed", {
    sessionKey: "agent:main:parent",
    agentId: "main",
  });
  await vi.advanceTimersByTimeAsync(0);
  await panel.updateComplete;
  expect(panel.querySelector(".chat-processes__output-empty")?.textContent).toContain(
    "No output yet",
  );
  expect(
    panel.querySelector(".chat-processes__output-empty .empty-state__icon svg"),
  ).not.toBeNull();
  result = { ...completeList, processes: [], truncated };
  connection.publishEvent("sessions.processes.changed", {
    sessionKey: "agent:main:parent",
    agentId: "main",
  });
  await vi.advanceTimersByTimeAsync(0);
  await panel.updateComplete;
  expect(panel.textContent).toContain(truncated ? "limited list" : "no longer retained");
  if (truncated) {
    expect(panel.textContent).not.toContain("no longer retained");
  }
  panel.querySelector<HTMLButtonElement>('button[aria-label="Back to Processes"]')!.click();
  await panel.updateComplete;
  expect(panel.querySelector(".chat-processes__list")?.textContent).toContain("No processes");
  expect(panel.querySelector(".chat-processes__list .empty-state__icon svg")).not.toBeNull();
});

it("keeps Stop separate from opening output and restores list focus after returning", async () => {
  const stopped = createDeferred<{ requested: boolean }>();
  let result: SessionsProcessesListResult = {
    sessionId: "parent-session",
    truncated: false,
    processes: [process({ tail: "Compiling\nReady", canStop: true })],
  };
  const request = vi.fn((method: string) =>
    method === "sessions.processes.stop" ? stopped.promise : result,
  );
  const { connection, mount } = mountProcesses(request);
  const panel = document.createElement("openclaw-chat-processes-panel");
  panel.sessionKey = "agent:main:parent";
  panel.mobile = true;
  mount(panel);
  await settle(panel, 0);
  await panel.updateComplete;
  const list = panel.querySelector<HTMLDivElement>(".chat-processes__list")!;
  list.scrollTop = 55;
  const opener = panel.querySelector<HTMLButtonElement>('button[aria-label="Build app"]')!;
  const stop = panel.querySelector<HTMLButtonElement>('button[aria-label="Stop Build app"]')!;
  stop.click();
  await panel.updateComplete;
  expect(request).toHaveBeenCalledWith("sessions.processes.stop", {
    key: "agent:main:parent",
    agentId: "main",
    sessionId: "parent-session",
    processId: "build",
    instanceId: "build-instance",
  });
  expect(stop.disabled).toBe(true);
  expect(list.hidden).toBe(false);
  await settle(panel, 0);
  expect(opener.isConnected).toBe(true);
  expect(panel.querySelector('button[aria-label="Build app"]')).toBe(opener);
  opener.click();
  await waitForSolid(() => {
    expect(panel.querySelector("pre")?.textContent).toBe("Compiling\nReady");
  });
  const detailStop = panel.querySelector<HTMLButtonElement>(
    '.chat-processes__detail button[aria-label="Stop Build app"]',
  )!;
  expect(detailStop.disabled).toBe(true);
  stopped.resolve({ requested: true });
  await vi.advanceTimersByTimeAsync(0);
  await panel.updateComplete;
  // Acknowledgment alone does not prove the process has exited.
  expect(detailStop.disabled).toBe(true);
  result = {
    ...result,
    processes: [{ ...result.processes[0]!, status: "killed", endedAt: 5000, canStop: false }],
  };
  connection.publishEvent("sessions.processes.changed", {
    sessionKey: panel.sessionKey,
    agentId: "main",
  });
  await vi.advanceTimersByTimeAsync(0);
  await panel.updateComplete;
  expect(
    panel.querySelector('.chat-processes__detail button[aria-label="Stop Build app"]'),
  ).toBeNull();
  panel.querySelector<HTMLButtonElement>('button[aria-label="Back to Processes"]')!.click();
  await panel.updateComplete;
  expect(list.hidden).toBe(false);
  expect(list.scrollTop).toBe(55);
  expect(document.activeElement).toBe(list);
  expect(
    request.mock.calls.filter(([method]) => method === "sessions.processes.stop"),
  ).toHaveLength(1);
});

it("retires stop authority immediately and reads the complete replacement scope", async () => {
  const request = vi.fn((method: string, params?: unknown) => {
    if (method === "sessions.processes.stop") {
      return { requested: true };
    }
    const target = asOptionalRecord(params);
    return {
      ...completeList,
      sessionId: target?.key === "global" ? "worker-session" : "parent-session",
      processes: target?.key === "global" ? [] : [process({ canStop: true })],
    } satisfies SessionsProcessesListResult;
  });
  const { mount } = mountProcesses(request);
  const panel = document.createElement("openclaw-chat-processes-panel");
  panel.sessionKey = "agent:main:parent";
  mount(panel);

  await settle(panel, 0);
  const stop = panel.querySelector<HTMLButtonElement>(".chat-processes__stop")!;
  expect(stop.disabled).toBe(false);

  panel.sessionKey = "global";
  panel.agentId = "worker";
  stop.click();
  expect(request.mock.calls.filter(([method]) => method === "sessions.processes.stop")).toEqual([]);
  await settle(panel, 0);
  expect(request.mock.calls).toEqual([mainRead, workerRead]);
});

it("keeps details process observation through refreshes and follows its presented scope", async () => {
  const request = vi.fn((method: string, params?: unknown) => {
    expect(method).toBe("sessions.processes.list");
    const target = asOptionalRecord(params);
    return {
      ...completeList,
      sessionId: target?.key === "global" ? "worker-session" : "parent-session",
      processes: [process({ name: target?.agentId === "worker" ? "Worker build" : "Main build" })],
    } satisfies SessionsProcessesListResult;
  });
  const { mount } = mountProcesses(request, ["sessions.processes.list"]);
  const details = document.createElement("openclaw-chat-details-session");
  details.props = {
    sessionKey: "agent:main:parent",
    currentAgentId: "main",
    selectedSession: undefined,
    messages: [],
    onOpenProcesses: () => {},
  };
  details.presented = true;
  mount(details);
  await settle(details, 0);
  const row = details.querySelector(".chat-details__process");
  expect(row?.textContent).toContain("Main build");
  expect(request.mock.calls).toEqual([mainRead]);

  details.props = { ...details.props!, messages: [] };
  await settle(details, 0);
  expect(details.querySelector(".chat-details__process")).toBe(row);
  expect(request).toHaveBeenCalledOnce();

  details.props = { ...details.props!, sessionKey: "global", currentAgentId: "worker" };
  await settle(details, 0);
  expect(request.mock.calls).toEqual([mainRead, workerRead]);
  expect(details.querySelector(".chat-details__process")?.textContent).toContain("Worker build");

  details.presented = false;
  details.props = { ...details.props!, sessionKey: "agent:main:parent", currentAgentId: "main" };
  await settle(details, 5_000);
  expect(request).toHaveBeenCalledTimes(2);

  details.presented = true;
  await settle(details, 0);
  expect(request.mock.calls).toEqual([mainRead, workerRead, mainRead]);
  expect(details.querySelector(".chat-details__process")?.textContent).toContain("Main build");
});

it("keeps the full panel read-error flow while compact Details retains its shared rows", async () => {
  const result = { ...completeList, processes: [process()] };
  const retry = createDeferred<SessionsProcessesListResult>();
  const request = vi
    .fn()
    .mockResolvedValueOnce(result)
    .mockRejectedValueOnce(new Error("Worker reconnecting"))
    .mockReturnValueOnce(retry.promise);
  const { connection, mount } = mountProcesses(request);
  const panel = document.createElement("openclaw-chat-processes-panel");
  panel.sessionKey = "agent:main:parent";
  const details = document.createElement("openclaw-chat-details-session");
  details.props = {
    sessionKey: panel.sessionKey,
    currentAgentId: "main",
    selectedSession: undefined,
    messages: [],
    onOpenProcesses: () => {},
  };
  details.presented = true;
  details.desktop = true;
  const surfaces = document.createElement("div");
  surfaces.append(panel, details);
  mount(surfaces);
  await settle(panel, 0);
  expect(request).toHaveBeenCalledOnce();
  expect(panel.textContent).toContain("Build app");
  expect(details.textContent).toContain("Build app");
  connection.publishEvent("sessions.processes.changed", {
    sessionKey: panel.sessionKey,
    agentId: "main",
  });
  await settle(panel, 0);
  expect(panel.textContent).not.toContain("Build app");
  expect(panel.querySelector('[role="alert"]')?.textContent).toContain("Worker reconnecting");
  expect(details.textContent).toContain("Build app");
  expect(details.textContent).not.toContain("Worker reconnecting");
  panel.querySelector<HTMLButtonElement>(".chat-processes__error button")!.click();
  await settle(panel, 0);
  expect(panel.querySelector('[role="alert"]')).toBeNull();
  expect(panel.textContent).not.toContain("Build app");
  expect(panel.querySelector('[role="status"]')?.getAttribute("aria-label")).toBe("Loading…");
  expect(panel.querySelector(".chat-processes__list")?.getAttribute("aria-busy")).toBe("true");
  expect(details.querySelector(".chat-details-processes")?.getAttribute("aria-busy")).toBe("true");
  expect(details.textContent).toContain("Build app");
  retry.resolve(result);
  await settle(panel, 0);
  expect(panel.textContent).toContain("Build app");
  expect(details.textContent).toContain("Build app");
  const opener = panel.querySelector<HTMLButtonElement>(".chat-processes__open")!;
  opener.click();
  await waitForSolid(() => expect(panel.querySelector("pre")?.textContent).toBe("Compiling"));
  panel.querySelector<HTMLButtonElement>('button[aria-label="Back to Processes"]')!.click();
  await waitForSolid(() => expect(document.activeElement).toBe(opener));
  expect(request).toHaveBeenCalledTimes(3);
});

it("keeps a shared held read and Stop alive when one presentation moves away", async () => {
  const first = createDeferred<SessionsProcessesListResult>();
  const stopped = createDeferred<{ requested: boolean }>();
  const result = { ...completeList, processes: [process({ canStop: true })] };
  const request = vi.fn((method: string, params?: unknown) => {
    if (method === "sessions.processes.stop") {
      return stopped.promise;
    }
    if (asOptionalRecord(params)?.key === "global") {
      return { ...completeList, processes: [process({ name: "Worker build" })] };
    }
    return first.promise;
  });
  const { mount } = mountProcesses(request);
  const panel = document.createElement("openclaw-chat-processes-panel");
  panel.sessionKey = "agent:main:parent";
  const details = document.createElement("openclaw-chat-details-session");
  details.props = {
    sessionKey: panel.sessionKey,
    currentAgentId: "main",
    selectedSession: undefined,
    messages: [],
    onOpenProcesses: () => {},
  };
  details.presented = true;
  details.desktop = true;
  const surfaces = document.createElement("div");
  surfaces.append(panel, details);
  mount(surfaces);
  await settle(panel, 0);
  expect(panel.querySelector(".chat-processes__list")?.getAttribute("aria-busy")).toBe("true");
  expect(request).toHaveBeenCalledOnce();
  panel.presented = false;
  panel.sessionKey = "global";
  panel.agentId = "worker";
  panel.presented = true;
  await settle(panel, 0);
  expect(panel.textContent).toContain("Worker build");
  expect(details.textContent).not.toContain("Build app");
  panel.sessionKey = "agent:main:parent";
  panel.agentId = "main";
  first.resolve(result);
  await settle(panel, 0);
  expect(details.textContent).toContain("Build app");
  expect(request.mock.calls.filter(([method]) => method === "sessions.processes.list")).toEqual([
    mainRead,
    workerRead,
  ]);
  panel.presented = true;
  await settle(panel, 0);
  panel.querySelector<HTMLButtonElement>(".chat-processes__stop")!.click();
  await settle(panel, 0);
  expect(details.querySelector<HTMLButtonElement>(".chat-details-processes__stop")!.disabled).toBe(
    true,
  );
  panel.sessionKey = "global";
  panel.agentId = "worker";
  await settle(panel, 0);
  expect(panel.textContent).toContain("Worker build");
  expect(details.textContent).toContain("Build app");
  expect(details.querySelector<HTMLButtonElement>(".chat-details-processes__stop")!.disabled).toBe(
    true,
  );
  expect(request.mock.calls.filter(([method]) => method === "sessions.processes.list")).toEqual([
    mainRead,
    workerRead,
    workerRead,
  ]);
  stopped.resolve({ requested: false });
  await settle(panel, 0);
  expect(panel.querySelector('[role="alert"]')).toBeNull();
  expect(details.querySelector<HTMLButtonElement>(".chat-details-processes__stop")!.disabled).toBe(
    false,
  );
});

it("retires a held Stop before a same-session replacement connection renders", async () => {
  const oldStop = createDeferred<{ requested: boolean }>();
  const nextStop = createDeferred<{ requested: boolean }>();
  const request = vi.fn((method: string) =>
    method === "sessions.processes.stop"
      ? oldStop.promise
      : { ...completeList, processes: [process({ canStop: true })] },
  );
  const { connection, mount } = mountProcesses(request);
  const panel = document.createElement("openclaw-chat-processes-panel");
  panel.sessionKey = "agent:main:parent";
  mount(panel);
  await settle(panel, 0);
  panel.querySelector<HTMLButtonElement>(".chat-processes__stop")!.click();
  await settle(panel, 0);
  const replacement = vi.fn((method: string) =>
    method === "sessions.processes.stop"
      ? nextStop.promise
      : { ...completeList, processes: [process({ name: "Replacement build", canStop: true })] },
  );
  connection.publish({ client: createTestGatewayClient(replacement) });
  await settle(panel, 0);
  expect(panel.textContent).toContain("Replacement build");
  const stop = panel.querySelector<HTMLButtonElement>(".chat-processes__stop")!;
  expect(stop.disabled).toBe(false);
  stop.click();
  await settle(panel, 0);
  expect(stop.disabled).toBe(true);
  oldStop.resolve({ requested: false });
  await settle(panel, 0);
  expect(stop.disabled).toBe(true);
  expect(panel.querySelector('[role="alert"]')).toBeNull();
  nextStop.resolve({ requested: false });
  await settle(panel, 0);
  expect(stop.disabled).toBe(false);
  expect(panel.querySelector('[role="alert"]')).not.toBeNull();
  expect(
    request.mock.calls.filter(([method]) => method === "sessions.processes.stop"),
  ).toHaveLength(1);
  expect(
    replacement.mock.calls.filter(([method]) => method === "sessions.processes.stop"),
  ).toHaveLength(1);
});
