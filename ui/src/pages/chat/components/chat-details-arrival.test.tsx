/* @vitest-environment jsdom */
import { createComponent, createSignal } from "solid-js";
import { expect, it, onTestFinished, vi } from "vitest";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { flush } from "../../../test-helpers/solid-settle.ts";
import { ChatDetailsDesktopComposition } from "./chat-details-session.tsx";
import type { ChatDetailsProps } from "./chat-details-types.ts";

function mountDetails() {
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
      artifactsLoading: true,
      artifactsError: null,
      dashboard: undefined,
      dashboardError: null,
      onOpenArtifact() {},
      onViewAll() {},
      renderArtifactIcon: () => null,
      renderViewAllIcon: () => null,
    },
    progressCardInitialLoading: true,
  };
  const [details, setDetails] = createSignal(initial);
  const [presented, setPresented] = createSignal(true);
  const view = mountSolid(() =>
    createComponent(ChatDetailsDesktopComposition, {
      get props() {
        return details();
      },
      get presented() {
        return presented();
      },
    }),
  );
  flush();
  onTestFinished(() => {
    view.unmount();
    if (animate) {
      Object.defineProperty(Element.prototype, "animate", animate);
    } else {
      Reflect.deleteProperty(Element.prototype, "animate");
    }
    vi.useRealTimers();
  });
  return {
    ...view,
    initial,
    update(patch: Partial<ChatDetailsProps>) {
      setDetails((previous) => ({ ...previous, ...patch }));
      flush();
    },
    present(value: boolean) {
      setPresented(value);
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
    outputs: { ...view.initial.outputs!, artifacts: [], artifactsLoading: false, dashboard: null },
  });
  expect(view.container.querySelector('[role="status"]')).toBeNull();
  expect(view.group("outputs")).toBeNull();
  view.update({ outputs: { ...view.initial.outputs!, artifacts: [], dashboard: null } });
  expect(view.group("outputs")).toBeNull();
  view.update({ outputs: { ...view.initial.outputs!, artifactsError: "Cannot load files" } });
  expect(view.group("outputs")?.textContent).toContain("Cannot load files");
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

it("delays the first Context arrival, preserves its deadline and disclosure, and retires a replaced session's pending entrance", async () => {
  const view = mountDetails();
  const usage = {
    ...view.initial.selectedSession!,
    contextTokens: 128_000,
    totalTokens: 3_840,
    totalTokensFresh: true,
  };
  view.update({ selectedSession: usage });
  expect(view.group("context")).toBeNull();
  await vi.advanceTimersByTimeAsync(1_000);
  view.update({ selectedSession: { ...usage, totalTokens: 5_120 } });
  view.present(false);
  await vi.advanceTimersByTimeAsync(2_000);
  expect(view.group("context")).toBeNull();
  view.present(true);
  await vi.advanceTimersByTimeAsync(1_000);
  view.update({ selectedSession: { ...usage, totalTokens: 6_400 } });
  await vi.advanceTimersByTimeAsync(999);
  expect(view.group("context")).toBeNull();
  await vi.advanceTimersByTimeAsync(1);
  const context = view.group("context")!;
  expect(context.textContent).toContain("5%");
  context.querySelector("summary")!.click();
  flush();
  expect(context.querySelector("summary")?.getAttribute("aria-expanded")).toBe("true");
  view.present(false);
  view.present(true);
  expect(view.group("context")).toBe(context);
  expect(context.querySelector("summary")?.getAttribute("aria-expanded")).toBe("true");

  view.update({
    sessionKey: "agent:main:pending",
    selectedSession: { key: "agent:main:pending", sessionId: "pending-1", kind: "direct" },
  });
  view.update({ selectedSession: { ...usage, key: "agent:main:pending", sessionId: "pending-1" } });
  await vi.advanceTimersByTimeAsync(1_000);
  view.update({
    sessionKey: "agent:main:empty",
    selectedSession: { key: "agent:main:empty", sessionId: "empty-1", kind: "direct" },
  });
  await vi.advanceTimersByTimeAsync(2_000);
  expect(view.group("context")).toBeNull();
  view.update({
    sessionKey: "agent:main:cached",
    selectedSession: { ...usage, key: "agent:main:cached", sessionId: "cached-1" },
  });
  expect(view.group("context")?.textContent).toContain("3%");
});

it("keeps an empty Environment absent while its owner reads, and admits each real content source", () => {
  const view = mountDetails();
  expect(view.group("environment")).toBeNull();
  const release = vi.fn();
  const request = vi.fn(() => release);
  const environment = { onRequestUncommitted: request };
  view.update({
    environment,
    desktopDisclosures: { expanded: { environment: false }, onExpandedChange() {} },
  });
  expect(request).toHaveBeenCalledTimes(1);
  expect(view.group("environment")).toBeNull();

  view.update({
    environment: {
      ...environment,
      uncommitted: {
        sessionKey: view.initial.sessionKey,
        baseRef: "HEAD",
        branch: "feature/arrival",
        files: [{ path: "example.ts", status: "modified", additions: 3, deletions: 1 }],
        additions: 3,
        deletions: 1,
      },
    },
  });
  expect(view.group("environment")?.textContent).toContain("Changes");
  expect(view.group("environment")?.querySelector("summary")?.getAttribute("aria-expanded")).toBe(
    "false",
  );
  expect(release).toHaveBeenCalledTimes(1);

  view.update({ environment });
  expect(view.group("environment")).toBeNull();
  expect(request).toHaveBeenCalledTimes(2);
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
      placement: {
        state: "active",
        generation: 1,
        createdAtMs: 1,
        updatedAtMs: 2,
        stateChangedAtMs: 2,
        environmentId: "worker:device",
        activeOwnerEpoch: 1,
        workerBundleHash: "a".repeat(64),
        workspaceBaseManifestRef: "base-manifest",
        remoteWorkspaceDir: "/worker/repo",
        runner: { kind: "device", status: "available" },
      },
    },
  });
  expect(view.group("environment")?.textContent).toContain("worker:device");
});
