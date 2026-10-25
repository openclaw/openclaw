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
