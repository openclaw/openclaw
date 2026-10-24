/* @vitest-environment jsdom */
import { createComponent, createSignal } from "solid-js";
import { expect, it, onTestFinished, vi } from "vitest";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { createActiveSessionPlacement } from "../../../test-helpers/session-placement.ts";
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
  view.update({ outputs: { ...view.initial.outputs!, artifacts: [], dashboard: null } });
  expect(view.group("outputs")).toBeNull();
  view.update({ outputs: { ...view.initial.outputs!, artifactsError: "Cannot load files" } });
  await vi.advanceTimersByTimeAsync(0);
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
      placement: createActiveSessionPlacement({
        updatedAtMs: 2,
        stateChangedAtMs: 2,
        workspaceBaseManifestRef: "base-manifest",
        remoteWorkspaceDir: "/worker/repo",
        runner: { kind: "device", status: "available" },
      }),
    },
  });
  expect(view.group("environment")?.textContent).toContain("worker:device");
});
