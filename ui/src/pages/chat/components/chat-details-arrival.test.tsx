/* @vitest-environment jsdom */
import { createComponent, createSignal } from "solid-js";
import { expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../../../test/helpers/promise.js";
import type { CronCompactJob, CronJobsListResult } from "../../../api/types.ts";
import { createApplicationGateway } from "../../../test-helpers/application-context-fixtures.ts";
import {
  createGatewayRequestMock,
  createTestGatewayClient,
} from "../../../test-helpers/gateway-client.ts";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { restorePropertyDescriptor } from "../../../test-helpers/property-descriptor.ts";
import { createActiveSessionPlacement } from "../../../test-helpers/session-placement.ts";
import { flush, waitForSolid } from "../../../test-helpers/solid-settle.ts";
import { ChatDetailsDesktopComposition } from "./chat-details-session.tsx";
import type { ChatDetailsProps } from "./chat-details-types.ts";

function mountDetails(overrides: Partial<ChatDetailsProps> = {}) {
  vi.useFakeTimers();
  // jsdom has no Web Animations API; real geometry and motion are covered in browser proof.
  const animate = Object.getOwnPropertyDescriptor(Element.prototype, "animate");
  Object.defineProperty(Element.prototype, "animate", {
    configurable: true,
    value: () => ({ cancel() {} }),
  });
  const initial: ChatDetailsProps = {
    sessionKey: "agent:main:arrival",
    currentAgentId: "main",
    messages: [],
    selectedSession: { key: "agent:main:arrival", kind: "direct", sessionId: "arrival-1" },
    desktopPresentation: {
      peopleLabel: "People",
      outputsLabel: "Outputs",
      subagentsWorkingLabel: "Working",
    },
    outputs: {
      artifacts: null,
      artifactsError: null,
      dashboard: undefined,
      dashboardError: null,
      onOpenArtifact() {},
      onViewAll() {},
      renderArtifactIcon: () => null,
      renderViewAllIcon: () => null,
    },
    progressCardInitialLoading: true,
    ...overrides,
  };
  const [details, setDetails] = createSignal(initial);
  const view = mountSolid(() =>
    createComponent(ChatDetailsDesktopComposition, {
      get props() {
        return details();
      },
      presented: true,
    }),
  );
  flush();
  onTestFinished(() => {
    view.unmount();
    restorePropertyDescriptor(Element.prototype, "animate", animate);
    vi.useRealTimers();
  });
  return {
    ...view,
    initial,
    update(patch: Partial<ChatDetailsProps>) {
      setDetails((previous) => ({ ...previous, ...patch }));
      flush();
    },
    group: (name: string) => view.container.querySelector(`[data-details-group="${name}"]`),
  };
}

it("keeps unknown and empty desktop Outputs and Progress quiet during slow reads", async () => {
  const view = mountDetails();
  expect(view.group("outputs")).toBeNull();
  expect(view.container.querySelector("openclaw-panel-loading-skeleton")).toBeNull();
  expect(view.container.querySelector('[role="status"]')).toBeNull();
  await vi.advanceTimersByTimeAsync(500);
  view.update({ progressCardInitialLoading: false, progressCard: null });
  expect(view.container.querySelector('[role="status"]')).toBeNull();
  view.update({ progressCardInitialLoading: true });
  await vi.advanceTimersByTimeAsync(2_000);
  expect(view.container.querySelector('[role="status"]')).toBeNull();
  view.update({
    progressCardInitialLoading: false,
    progressCard: null,
    outputs: { ...view.initial.outputs!, artifacts: [], dashboard: null },
  });
  expect(view.container.querySelector('[role="status"]')).toBeNull();
  expect(view.group("outputs")).toBeNull();
  view.update({ outputs: { ...view.initial.outputs!, artifactsError: "Cannot load files" } });
  const outputs = view.group("outputs")!;
  expect(outputs.querySelector("summary")?.getAttribute("aria-expanded")).toBe("false");
  outputs.querySelector("summary")!.click();
  await vi.advanceTimersByTimeAsync(0);
  await waitForSolid(() =>
    expect(view.group("outputs")?.textContent).toContain("Cannot load files"),
  );
  view.update({
    outputs: { ...view.initial.outputs!, dashboard: { title: "Build report", onOpen() {} } },
    progressCard: {
      sessionKey: view.initial.sessionKey,
      revision: 1,
      updatedAt: 1,
      steps: [{ step: "Review the layout", status: "in_progress" }],
    },
  });
  expect(view.group("outputs")?.textContent).toContain("Build report");
  expect(view.container.textContent).toContain("Review the layout");
});

it("appends late desktop automations after retained Outputs and task progress", async () => {
  const pending = createDeferred<CronJobsListResult<CronCompactJob>>();
  const request = createGatewayRequestMock(() => pending.promise);
  const { gateway, publish } = createApplicationGateway();
  publish({
    ...gateway.snapshot,
    client: createTestGatewayClient(request),
    phase: "connected",
    hello: { type: "hello-ok", protocol: 4, auth: { role: "operator", scopes: ["operator.read"] } },
    assistantAgentId: "main",
    sessionKey: "agent:main:arrival",
  });
  const view = mountDetails({ pullRequestsGateway: gateway });
  view.update({
    outputs: { ...view.initial.outputs!, dashboard: { title: "Build report", onOpen() {} } },
    progressCard: {
      sessionKey: view.initial.sessionKey,
      revision: 1,
      updatedAt: 1,
      steps: [{ step: "Review the layout", status: "in_progress" }],
    },
  });
  const outputs = view.group("outputs")!;
  const progress = view.container.querySelector("openclaw-chat-details-progress")!;
  expect(view.group("automations")).toBeNull();
  const jobs: CronCompactJob[] = Array.from({ length: 10 }, (_, index) => ({
    id: `arrival-${index}`,
    name: `Scheduled check ${index}`,
    agentId: "main",
    enabled: true,
    updatedAtMs: 1,
    nextRunAt: null,
    nextRunAtMs: null,
    scheduleKind: "every",
    schedule: { kind: "every", everyMs: 600_000 },
    lastRunAt: null,
    lastRunAtMs: null,
    lastRunStatus: null,
    lastRunError: null,
  }));
  pending.resolve({
    jobs,
    snapshotRevision: "arrival-1",
    offset: 0,
    limit: 50,
    total: jobs.length,
    hasMore: false,
    nextOffset: null,
  });
  await vi.advanceTimersByTimeAsync(0);
  flush();
  const automations = view.group("automations")!;
  expect(automations.querySelectorAll(".chat-summary__automation")).toHaveLength(10);
  expect(view.group("outputs")).toBe(outputs);
  expect(view.container.querySelector("openclaw-chat-details-progress")).toBe(progress);
  expect(outputs.compareDocumentPosition(automations) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(
    0,
  );
  expect(progress.compareDocumentPosition(automations) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(
    0,
  );
  expect(request).toHaveBeenCalledOnce();
});

it("admits each real Environment content source without an empty section", async () => {
  const view = mountDetails();
  expect(view.group("environment")).toBeNull();
  view.update({
    environment: {
      uncommitted: {
        sessionKey: view.initial.sessionKey,
        files: [{ path: "example.ts", status: "modified", additions: 3, deletions: 1 }],
        additions: 3,
        deletions: 1,
      },
    },
  });
  await waitForSolid(() => expect(view.group("environment")?.textContent).toContain("Changes"));

  view.update({ environment: undefined });
  expect(view.group("environment")).toBeNull();
  view.update({ detailsWorkspace: { root: null, label: null, branch: "feature/arrival" } });
  expect(view.group("environment")?.textContent).toContain("feature/arrival");
  view.update({
    detailsWorkspace: undefined,
    selectedSession: {
      ...view.initial.selectedSession!,
      worktree: { id: "arrival-tree", branch: "feature/worktree", repoRoot: "/workspace/example" },
    },
  });
  expect(view.group("environment")?.textContent).toContain("Worktree");
  view.update({ selectedSession: view.initial.selectedSession });
  expect(view.group("environment")).toBeNull();
  view.update({
    selectedSession: {
      ...view.initial.selectedSession!,
      placement: createActiveSessionPlacement({
        runner: { kind: "device", status: "available" },
      }),
    },
  });
  expect(view.group("environment")?.textContent).toContain("worker:device");
});

function automationPage(name: string): CronJobsListResult<CronCompactJob> {
  return {
    jobs: [
      {
        id: name,
        name,
        agentId: "main",
        enabled: true,
        updatedAtMs: 1,
        nextRunAt: null,
        nextRunAtMs: null,
        scheduleKind: "every",
        schedule: { kind: "every", everyMs: 600_000 },
        lastRunAt: null,
        lastRunAtMs: null,
        lastRunStatus: null,
        lastRunError: null,
      },
    ],
    snapshotRevision: name,
    offset: 0,
    limit: 50,
    total: 1,
    hasMore: false,
    nextOffset: null,
  };
}

function automationGateway(request: ReturnType<typeof createGatewayRequestMock>) {
  const { gateway, publish } = createApplicationGateway();
  publish({
    ...gateway.snapshot,
    client: createTestGatewayClient(request),
    phase: "connected",
    hello: { type: "hello-ok", protocol: 4, auth: { role: "operator", scopes: ["operator.read"] } },
    assistantAgentId: "main",
    sessionKey: "agent:main:arrival",
  });
  return { gateway, publish };
}

it("retains cached Subagents until the roster observes its parent, then adopts no children", async () => {
  const remember = vi.fn<NonNullable<ChatDetailsProps["onDetailsSnapshot"]>>();
  const view = mountDetails({
    selectedSession: undefined,
    subagentSessionsHydrated: true,
    onOpenSubagent() {},
    onOpenSubagents() {},
    onDetailsSnapshot: remember,
    cachedDetails: {
      locale: "en",
      subagents: {
        total: 1,
        rows: [{ key: "agent:main:subagent:review", label: "Review", status: "done" }],
        counts: [{ status: "done", count: 1 }],
      },
    },
  });
  await vi.advanceTimersByTimeAsync(0);
  flush();
  expect(remember).not.toHaveBeenCalled();
  expect(view.group("subagents")?.textContent).toContain("Review");
  view.update({ selectedSession: { key: view.initial.sessionKey, kind: "direct" } });
  await vi.advanceTimersByTimeAsync(0);
  flush();
  expect(view.group("subagents")?.textContent).toContain("Review");
  expect(remember).not.toHaveBeenCalled();
  view.update({ subagentSessions: [] });
  await vi.advanceTimersByTimeAsync(0);
  flush();
  expect(view.group("subagents")?.textContent).toContain("Review");
  expect(remember).not.toHaveBeenCalled();
  view.update({ subagentSessions: [{ key: view.initial.sessionKey, kind: "direct" }] });
  await vi.advanceTimersByTimeAsync(0);
  flush();
  expect(view.group("subagents")).toBeNull();
  expect(remember).toHaveBeenCalledWith({ subagents: { total: 0, rows: [], counts: [] } });
});

it("retires an automation page when the logical session changes", async () => {
  const retired = createDeferred<CronJobsListResult<CronCompactJob>>();
  const current = createDeferred<CronJobsListResult<CronCompactJob>>();
  const request = createGatewayRequestMock()
    .mockReturnValueOnce(retired.promise)
    .mockReturnValueOnce(current.promise);
  const view = mountDetails({ pullRequestsGateway: automationGateway(request).gateway });
  expect(request).toHaveBeenCalledOnce();
  view.update({
    sessionKey: "agent:main:replacement",
    selectedSession: { key: "agent:main:replacement", kind: "direct", sessionId: "replacement-1" },
  });
  expect(request).toHaveBeenCalledTimes(2);
  expect(request.mock.calls[1]?.[1]).toMatchObject({
    sessionKey: "agent:main:replacement",
    sessionAgentId: "main",
  });
  retired.resolve(automationPage("Retired automation"));
  await vi.advanceTimersByTimeAsync(0);
  flush();
  expect(view.container.textContent).not.toContain("Retired automation");

  current.resolve(automationPage("Current automation"));
  await vi.advanceTimersByTimeAsync(0);
  flush();
  expect(view.group("automations")?.textContent).toContain("Current automation");
  expect(view.container.textContent).not.toContain("Retired automation");
  expect(request).toHaveBeenCalledTimes(2);
});

it.each([false, true])(
  "keeps disclosure reset and restored preference: controlled=%s",
  async (controlled) => {
    const request = createGatewayRequestMock(() =>
      Promise.resolve(automationPage("Scheduled check")),
    );
    const onExpandedChange = vi.fn();
    const view = mountDetails({
      pullRequestsGateway: automationGateway(request).gateway,
      ...(controlled
        ? { desktopDisclosures: { expanded: { automations: false }, onExpandedChange } }
        : {}),
    });
    await vi.advanceTimersByTimeAsync(0);
    flush();
    const summary = () => view.group("automations")!.querySelector("summary")!;
    expect(summary().getAttribute("aria-expanded")).toBe(controlled ? "false" : "true");
    if (!controlled) {
      summary().click();
      flush();
      expect(summary().getAttribute("aria-expanded")).toBe("false");
    }
    view.update({ selectedSession: undefined });
    view.update({ selectedSession: view.initial.selectedSession });
    await vi.advanceTimersByTimeAsync(0);
    flush();
    expect(summary().getAttribute("aria-expanded")).toBe(controlled ? "false" : "true");
    expect(request).toHaveBeenCalledOnce();
    expect(onExpandedChange).not.toHaveBeenCalled();
  },
);

it("resets only the automation reveal count across physical identity changes", async () => {
  const page = automationPage("Scheduled check");
  page.jobs = Array.from({ length: 12 }, (_, index) => ({
    ...page.jobs[0]!,
    id: `scheduled-${index}`,
    name: `Scheduled check ${index}`,
  }));
  page.total = page.jobs.length;
  const request = createGatewayRequestMock(() => Promise.resolve(page));
  const view = mountDetails({ pullRequestsGateway: automationGateway(request).gateway });
  await vi.advanceTimersByTimeAsync(0);
  flush();
  const count = () =>
    view.group("automations")!.querySelectorAll(".chat-summary__automation").length;
  const more = () =>
    view.group("automations")!.querySelector<HTMLButtonElement>(".chat-summary__automation-more")!;
  expect(count()).toBe(10);
  more().click();
  flush();
  expect(count()).toBe(12);
  view.update({ progressCardInitialLoading: false });
  expect(count()).toBe(12);

  view.update({ selectedSession: undefined });
  view.update({ selectedSession: view.initial.selectedSession });
  await vi.advanceTimersByTimeAsync(0);
  flush();
  expect(count()).toBe(10);
  more().click();
  flush();
  expect(count()).toBe(12);
  view.update({ selectedSession: { ...view.initial.selectedSession!, sessionId: "arrival-2" } });
  await vi.advanceTimersByTimeAsync(0);
  flush();
  expect(count()).toBe(10);
  expect(request).toHaveBeenCalledOnce();
});

it("accepts one replacement-client page while its physical session row is restored", async () => {
  const retired = createDeferred<CronJobsListResult<CronCompactJob>>();
  const current = createDeferred<CronJobsListResult<CronCompactJob>>();
  const oldRequest = createGatewayRequestMock(() => retired.promise);
  const newRequest = createGatewayRequestMock(() => current.promise);
  const source = automationGateway(oldRequest);
  const view = mountDetails({ pullRequestsGateway: source.gateway });
  expect(oldRequest).toHaveBeenCalledOnce();
  const hello = source.gateway.snapshot.hello;
  const client = createTestGatewayClient(newRequest);
  source.publish({ ...source.gateway.snapshot, client, phase: "connecting", hello: null });
  // The Gateway fixture publishes connection facts, not the session owner's Details props.
  view.update({ selectedSession: undefined });
  expect(newRequest).not.toHaveBeenCalled();
  source.publish({ ...source.gateway.snapshot, client, phase: "connected", hello });
  flush();
  expect(newRequest).toHaveBeenCalledOnce();
  view.update({ selectedSession: view.initial.selectedSession });
  expect(newRequest).toHaveBeenCalledOnce();

  retired.resolve(automationPage("Retired client automation"));
  await vi.advanceTimersByTimeAsync(0);
  flush();
  expect(view.container.textContent).not.toContain("Retired client automation");
  current.resolve(automationPage("Replacement client automation"));
  await vi.advanceTimersByTimeAsync(0);
  flush();
  expect(view.group("automations")?.textContent).toContain("Replacement client automation");
  expect(view.container.textContent).not.toContain("Retired client automation");
  expect(oldRequest).toHaveBeenCalledOnce();
  expect(newRequest).toHaveBeenCalledOnce();

  view.update({ selectedSession: { ...view.initial.selectedSession!, sessionId: "arrival-2" } });
  expect(view.group("automations")?.textContent).toContain("Replacement client automation");
  expect(newRequest).toHaveBeenCalledOnce();
});

it("does not reapply a pending reveal after the same physical identity is restored", async () => {
  const first = automationPage("Scheduled check");
  first.jobs = Array.from({ length: 50 }, (_, index) => ({
    ...first.jobs[0]!,
    id: `scheduled-${index}`,
    name: `Scheduled check ${index}`,
  }));
  first.total = 51;
  first.hasMore = true;
  first.nextOffset = 50;
  const appended = createDeferred<CronJobsListResult<CronCompactJob>>();
  const request = createGatewayRequestMock()
    .mockResolvedValueOnce(first)
    .mockReturnValueOnce(appended.promise);
  const view = mountDetails({ pullRequestsGateway: automationGateway(request).gateway });
  await vi.advanceTimersByTimeAsync(0);
  flush();
  const group = () => view.group("automations")!;
  const count = () => group().querySelectorAll(".chat-summary__automation").length;
  const more = () => group().querySelector<HTMLButtonElement>(".chat-summary__automation-more")!;
  expect(count()).toBe(10);
  for (const expected of [20, 30, 40, 50]) {
    more().click();
    flush();
    expect(count()).toBe(expected);
    expect(request).toHaveBeenCalledOnce();
  }
  const button = more();
  button.focus();
  button.click();
  flush();
  expect(request).toHaveBeenCalledTimes(2);
  expect(request.mock.calls[1]?.[1]).toMatchObject({ limit: 50, offset: 50 });
  view.update({ selectedSession: undefined });
  view.update({ selectedSession: view.initial.selectedSession });
  expect(request).toHaveBeenCalledTimes(2);
  // The pending read retains its current frame; the reset lands with that read.
  expect(count()).toBe(50);

  appended.resolve({
    ...automationPage("Appended automation"),
    snapshotRevision: first.snapshotRevision,
    offset: 50,
    total: 51,
  });
  await vi.advanceTimersByTimeAsync(0);
  flush();
  expect(count()).toBe(10);
  expect(group().textContent).not.toContain("Appended automation");
  expect(request).toHaveBeenCalledTimes(2);

  for (const expected of [20, 30, 40, 50, 51]) {
    more().click();
    flush();
    expect(count()).toBe(expected);
    expect(request).toHaveBeenCalledTimes(2);
  }
  expect(group().textContent).toContain("Appended automation");
});
