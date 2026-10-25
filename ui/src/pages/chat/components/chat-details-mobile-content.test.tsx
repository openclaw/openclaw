/* @vitest-environment jsdom */
import { createSignal, flush } from "solid-js";
import { expect, it, vi } from "vitest";
import "../chat-details-mobile-host-content.tsx";
import type { GatewaySessionRow } from "../../../api/types.ts";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { createActiveSessionPlacement } from "../../../test-helpers/session-placement.ts";
import { waitForSolid } from "../../../test-helpers/solid-settle.ts";
import {
  createChatMobileHostFixture,
  createMobileRootContentFixture as rootContent,
} from "../chat-mobile-host.test-support.ts";
import type { ChatMobileHost, MobileHostDestination } from "../chat-mobile-host.ts";
import {
  ChatDetailsMobileContent,
  type ChatDetailsMobilePage,
} from "./chat-details-mobile-content.tsx";
import type { ChatDetailsProps } from "./chat-details-types.ts";
import { publication, pullRequest, sessionBranch } from "./chat-pull-requests.test-support.ts";

function details(overrides: Partial<ChatDetailsProps> = {}): ChatDetailsProps {
  return {
    sessionKey: "agent:main:details",
    currentAgentId: "main",
    messages: [],
    selectedSession: { key: "agent:main:details", kind: "direct" },
    ...overrides,
  };
}

it("shows a real worker without legacy fields and lets the environment owner decide empty state", () => {
  const active: GatewaySessionRow = {
    key: "agent:main:details",
    kind: "direct",
    placement: createActiveSessionPlacement({
      createdAtMs: 100000,
      updatedAtMs: 300000,
      stateChangedAtMs: 300000,
      workspaceBaseManifestRef: "base-manifest",
      remoteWorkspaceDir: "/worker/repo",
      runner: { kind: "device", status: "available" },
    }),
  };
  const [presented, setPresented] = createSignal(true);
  const request = vi.fn();
  const openMachine = vi.fn();
  const environment = { onRequestUncommitted: request, onOpenMachine: openMachine };
  const [value, setValue] = createSignal(details({ selectedSession: active, environment }));
  const content = rootContent();
  const view = mountSolid(() => (
    <ChatDetailsMobileContent
      details={value()}
      presented={presented()}
      page={{ kind: "root", content }}
    />
  ));
  view.getByRole("button", { name: "worker:device" }).click();
  expect(openMachine).toHaveBeenCalledOnce();
  expect(request).toHaveBeenCalledOnce();
  setValue(
    details({
      selectedSession: { key: "agent:main:details", kind: "direct", execNode: "Local Gateway" },
      environment,
    }),
  );
  flush();
  expect(view.queryByRole("region", { name: "Environment" })).toBeNull();
  expect(request).toHaveBeenCalledOnce();
  setValue(details({ environment }));
  flush();
  expect(view.queryByRole("region", { name: "Environment" })).toBeNull();
  expect(request).toHaveBeenCalledOnce();
  setPresented(false);
  flush();
  setPresented(true);
  flush();
  expect(request).toHaveBeenCalledTimes(2);
});

it("retains Outputs demand across publications and returns navigation origins without a second route owner", () => {
  const release = vi.fn();
  const retain = vi.fn(() => release);
  const output = {
    artifacts: [],
    artifactsError: null,
    dashboard: null,
    dashboardError: null,
    onOpenArtifact: vi.fn(),
    renderArtifactIcon: () => null,
    onViewAll: vi.fn(),
    renderViewAllIcon: () => null,
  };
  const [value, setValue] = createSignal(details({ outputs: output, retainOutputs: retain }));
  const [presented, setPresented] = createSignal(true);
  const content = rootContent();
  const [page, setPage] = createSignal<ChatDetailsMobilePage>({ kind: "root", content });
  const view = mountSolid(() => (
    <ChatDetailsMobileContent details={value()} presented={presented()} page={page()} />
  ));
  expect(retain).toHaveBeenCalledOnce();
  const people = view.getByRole("button", { name: "People" });
  people.click();
  expect(content.entries.onNavigate).toHaveBeenCalledWith(
    { kind: "people" },
    { kind: "details-root", trigger: people },
  );
  view.getByRole("button", { name: /Versions/ }).click();
  expect(content.entries.onNavigate).toHaveBeenLastCalledWith(
    { kind: "versions" },
    expect.objectContaining({ kind: "details-root" }),
  );
  setValue((current) => ({ ...current, outputs: { ...output, artifacts: null } }));
  flush();
  expect(retain).toHaveBeenCalledOnce();
  expect(release).not.toHaveBeenCalled();
  setPage({ kind: "outputs" });
  flush();
  expect(retain).toHaveBeenCalledOnce();
  setPage({
    kind: "task-progress",
    content: { showTaskProgress: true, onShowTaskProgressChange: vi.fn() },
  });
  flush();
  expect(release).toHaveBeenCalledOnce();
  setPage({ kind: "root", content });
  flush();
  expect(retain).toHaveBeenCalledTimes(2);
  setPresented(false);
  flush();
  expect(release).toHaveBeenCalledTimes(2);
  const hiddenPeople = view.getByRole("button", { name: "People" });
  expect(hiddenPeople.hasAttribute("disabled")).toBe(true);
  hiddenPeople.click();
  expect(content.entries.onNavigate).toHaveBeenCalledTimes(2);
  setPresented(true);
  flush();
  expect(retain).toHaveBeenCalledTimes(3);
  expect(view.getByRole("button", { name: "People" })).toBe(hiddenPeople);
  const releaseReplacement = vi.fn();
  const retainReplacement = vi.fn(() => releaseReplacement);
  setValue((current) => ({ ...current, retainOutputs: retainReplacement }));
  flush();
  expect(release).toHaveBeenCalledTimes(3);
  expect(retainReplacement).toHaveBeenCalledOnce();
  expect(view.getByRole("button", { name: "People" })).toBe(hiddenPeople);
  view.unmount();
  expect(release).toHaveBeenCalledTimes(3);
  expect(releaseReplacement).toHaveBeenCalledOnce();
});

async function mountMobileHost(value: ChatDetailsProps) {
  const navigate = vi.fn<(destination: MobileHostDestination) => void>();
  const host: ChatMobileHost = createChatMobileHostFixture("mobile-pr-session", {
    open: true,
    height: 280,
    reservedHeight: 280,
    destination: { area: "details" },
    navigate,
  });
  const element = document.createElement("openclaw-chat-details-mobile-host-content");
  element.details = value;
  element.host = host;
  element.presented = true;
  element.bindings = {
    goal: { connected: false, canAct: false },
    pullRequests: {
      snapshot: {
        pullRequests: value.pullRequests ?? [],
        rateLimited: false,
        status: "ready",
      },
      requestRefresh: () => false,
    },
  };
  const view = mountSolid(() => element);
  await element.updateComplete;
  flush();
  const show = async (destination: MobileHostDestination) => {
    element.host = { ...element.host!, destination };
    await element.updateComplete;
    flush();
  };
  return { view, element, navigate, show };
}

it("replaces the People activation owner while retaining the mobile host content", async () => {
  const { view, element, show } = await mountMobileHost(details());
  const release = vi.fn();
  const activate = vi.fn(() => release);
  const releaseReplacement = vi.fn();
  const activateReplacement = vi.fn(() => releaseReplacement);
  const mentions = {
    status: "idle" as const,
    error: undefined,
    truncated: false,
    read: () => null,
    request: async () => {},
    insert: () => false,
    activate,
  };
  try {
    const root = view.container.querySelector(".chat-details-mobile-root");
    element.bindings = { ...element.bindings!, peopleMentions: mentions };
    await element.updateComplete;
    expect(activate).not.toHaveBeenCalled();
    await show({
      area: "details",
      page: { key: "people", title: "People", details: { kind: "people" } },
    });
    expect(activate).toHaveBeenCalledOnce();
    for (const status of ["loading", "ready"] as const) {
      element.bindings = { ...element.bindings!, peopleMentions: { ...mentions, status } };
      await element.updateComplete;
      flush();
      expect(activate).toHaveBeenCalledOnce();
      expect(release).not.toHaveBeenCalled();
      expect(view.container.querySelector(".chat-details-mobile-root")).toBe(root);
    }
    element.bindings = {
      ...element.bindings!,
      peopleMentions: { ...mentions, activate: activateReplacement },
    };
    await element.updateComplete;
    flush();
    expect(release).toHaveBeenCalledOnce();
    expect(activateReplacement).toHaveBeenCalledOnce();
    expect(view.container.querySelector(".chat-details-mobile-root")).toBe(root);
    await show({ area: "details" });
    expect(releaseReplacement).toHaveBeenCalledOnce();
    expect(view.container.querySelector(".chat-details-mobile-root")).toBe(root);
  } finally {
    view.unmount();
  }
  expect(release).toHaveBeenCalledOnce();
  expect(releaseReplacement).toHaveBeenCalledOnce();
});

it("routes current mobile PRs to Checks and rejects hidden or superseded navigation", async () => {
  const request = pullRequest({
    title: "Current PR",
    headSha: "a".repeat(40),
    additions: 1234,
    deletions: 2000,
  });
  const value = details({ pullRequests: [request], pullRequestsSessionId: "session-current" });
  const { view, element, navigate, show } = await mountMobileHost(value);
  try {
    const rootRow = view.container.querySelector<HTMLButtonElement>(
      '[data-details-page="root"] .chat-pr-mobile__row',
    )!;
    expect(rootRow.querySelector(".chat-pr__additions")?.textContent).toBe("+1,234");
    expect(rootRow.querySelector(".chat-pr__deletions")?.textContent).toBe("−2,000");
    expect(rootRow.querySelector(".chat-pr-mobile__row-meta")?.textContent).toContain(
      "+1,234 −2,000",
    );
    rootRow.click();
    expect(navigate).toHaveBeenCalledOnce();
    const destination = navigate.mock.calls[0]![0];
    expect(destination.page?.details).toEqual({
      kind: "pull-request",
      id: "openclaw/openclaw#103469",
    });
    expect(destination.backTo).toEqual({ area: "details" });
    await show(destination);
    expect(view.container.querySelector(".chat-pr-mobile__diff")?.textContent).toContain(
      "+1,234−2,000",
    );

    rootRow.click();
    expect(navigate).toHaveBeenCalledOnce();
    view.getByRole("button", { name: "Checks" }).click();
    expect(navigate).toHaveBeenCalledTimes(2);
    const checks = navigate.mock.calls[1]![0];
    expect(checks.page?.details).toEqual({
      kind: "pull-request-checks",
      id: "openclaw/openclaw#103469",
    });
    expect(checks.backTo).toBe(destination);
    await show(checks);
    const checksPage = view.container.querySelector<HTMLElement>(
      '[data-details-page="pull-request-checks"]',
    )!;
    expect(checksPage.hidden).toBe(false);
    expect(checksPage.querySelector("openclaw-chat-ci-details")).not.toBeNull();
    rootRow.click();
    expect(navigate).toHaveBeenCalledTimes(2);

    await show(destination);
    const staleChecks = view.getByRole("button", { name: "Checks" });
    // Native receipts change synchronously; the previous rendered handler must retire before flush.
    element.details = details({ pullRequests: [pullRequest({ title: "Replacement PR" })] });
    staleChecks.click();
    expect(navigate).toHaveBeenCalledTimes(2);
    await element.updateComplete;
    flush();
    const previousHostChecks = view.getByRole("button", { name: "Checks" });
    element.host = { ...element.host!, scopeKey: "replacement-session" };
    previousHostChecks.click();
    expect(navigate).toHaveBeenCalledTimes(2);
  } finally {
    view.unmount();
  }
});

it("dismisses only the current mobile branch after explicit activation", async () => {
  const branch = sessionBranch({ branch: "feature/current" });
  const dismiss = vi.fn();
  const value = details({
    pullRequestsBranch: branch,
    githubPublication: publication(),
    onDismissPullRequestsBranch: dismiss,
  });
  const { view, element, navigate, show } = await mountMobileHost(value);
  try {
    view.container
      .querySelector<HTMLButtonElement>(
        '[data-details-page="root"] [data-details-destination="publication"]',
      )!
      .click();
    expect(navigate).toHaveBeenCalledOnce();
    const destination = navigate.mock.calls[0]![0];
    await show(destination);
    const staleHide = await waitForSolid(() =>
      view.getByRole("button", { name: "Hide feature/current for this session" }),
    );
    expect(dismiss).not.toHaveBeenCalled();
    const replacement = sessionBranch({ branch: "feature/replacement" });
    element.details = { ...value, pullRequestsBranch: replacement };
    staleHide.click();
    expect(dismiss).not.toHaveBeenCalled();
    await element.updateComplete;
    flush();

    const previousHostHide = view.getByRole("button", {
      name: "Hide feature/replacement for this session",
    });
    element.host = { ...element.host! };
    previousHostHide.click();
    expect(dismiss).not.toHaveBeenCalled();
    await element.updateComplete;
    flush();

    view
      .getByRole("button", {
        name: "Hide feature/replacement for this session",
      })
      .click();
    expect(dismiss).toHaveBeenCalledExactlyOnceWith(replacement);
    expect(navigate).toHaveBeenCalledTimes(2);
    expect(navigate).toHaveBeenLastCalledWith(destination.backTo);
    element.details = { ...element.details!, pullRequestsBranchDismissed: true };
    await show(destination.backTo!);
    expect(view.container.querySelector('[data-details-destination="publication"]')).toBeNull();
    expect(view.container.querySelector('[data-details-page="publication"]')).toBeNull();

    element.details = { ...element.details!, githubPublication: publication({ locked: true }) };
    await element.updateComplete;
    flush();
    expect(view.container.querySelector('[data-details-destination="publication"]')).not.toBeNull();
    expect(view.container.querySelector('[data-details-page="publication"]')).not.toBeNull();
    expect(view.container.querySelector(".chat-pr-mobile__hide")).toBeNull();
  } finally {
    view.unmount();
  }
});
