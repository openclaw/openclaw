/* @vitest-environment jsdom */
import { createComponent, createSignal } from "solid-js";
import { expect, it, onTestFinished, vi } from "vitest";
import type { SessionsDiffResult } from "../../../../../packages/gateway-protocol/src/index.js";
import { createDeferred } from "../../../../../test/helpers/promise.js";
import type { GatewaySessionRow } from "../../../api/types.ts";
import { fnv1aUtf16 } from "../../../lib/fnv1a.ts";
import type { SolidBridgeElement } from "../../../lib/solid-bridge.ts";
import { createApplicationGateway } from "../../../test-helpers/application-context-fixtures.ts";
import {
  createGatewayRequestMock,
  createTestGatewayClient,
} from "../../../test-helpers/gateway-client.ts";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { restorePropertyDescriptor } from "../../../test-helpers/property-descriptor.ts";
import { createActiveSessionPlacement } from "../../../test-helpers/session-placement.ts";
import { flush, waitForSolid } from "../../../test-helpers/solid-settle.ts";
import { ChatContextPanel } from "./chat-context-panel.tsx";
import { ChatDetailsEnvironmentMobile } from "./chat-details-environment-mobile.tsx";
import { ChatDetailsEnvironment } from "./chat-details-environment.tsx";
import { ChatDetailsSession } from "./chat-details-session.tsx";
import type { ChatDetailsProps } from "./chat-details-types.ts";
import { publication, sessionBranch, pullRequest } from "./chat-pull-requests.test-support.ts";
import type { SubagentActivityProps } from "./chat-subagent-activity.tsx";

type ChatSubagentActivityLive = SolidBridgeElement<SubagentActivityProps>;
const sessionKey = "agent:main:details";
const session = (overrides: Partial<GatewaySessionRow> = {}): GatewaySessionRow => ({
  key: sessionKey,
  kind: "direct",
  ...overrides,
});
const details = (overrides: Partial<ChatDetailsProps> = {}): ChatDetailsProps => ({
  sessionKey,
  currentAgentId: "main",
  messages: [],
  selectedSession: session(),
  ...overrides,
});
const query = <E extends Element = HTMLElement>(root: ParentNode, selector: string) =>
  root.querySelector<E>(selector);
const domText = (root: ParentNode, selector: string) => query(root, selector)?.textContent;
const detailsGroup = (root: ParentNode, name: string) =>
  query<HTMLDetailsElement>(root, `[data-details-group="${name}"]`);
async function update(element: ChatDetailsSession, changes: Partial<ChatDetailsProps>) {
  element.props = { ...element.props!, ...changes };
  await element.updateComplete;
}
async function activity(root: ParentNode) {
  await waitForSolid(() => expect(query(root, "openclaw-chat-subagent-activity")).not.toBeNull());
  const live = query<ChatSubagentActivityLive>(root, "openclaw-chat-subagent-activity")!;
  await live.updateComplete;
  return live;
}
const linkedWork = (root: ParentNode) =>
  query(
    root,
    '[data-details-group="pull-requests"], [data-details-group="automations"], [data-details-group="subagents"], [data-details-group="processes"]',
  );
const workspace = (branch = "feature/details", root = "/synthetic/project") => ({
  root,
  label: "project",
  branch,
});

async function mount(overrides: Partial<ChatDetailsProps> = {}) {
  const value = details(overrides);
  const view = mountSolid(() =>
    createComponent(ChatDetailsSession, { props: value, presented: true }),
  );
  const element = view.container.querySelector("openclaw-chat-details-session")!;
  await element.updateComplete;
  return element;
}
it("omits empty linked-work disclosures and opens arriving pull requests", async () => {
  const element = await mount();
  expect(linkedWork(element)).toBeNull();
  await update(element, {
    pullRequests: [
      {
        number: 7,
        owner: "example",
        repo: "project",
        branch: "feature",
        title: "A pull request arriving after the panel opens",
        url: "https://github.com/example/project/pull/7",
        state: "open",
      },
    ],
  });
  const group = detailsGroup(element, "pull-requests")!;
  expect(group.open).toBe(true);
  group.open = false;
  group.dispatchEvent(new Event("toggle"));
  flush();
  await update(element, {});
  expect(group.open).toBe(false);
  const pullRequests = element.props!.pullRequests;
  await update(element, { pullRequests: [] });
  expect(linkedWork(element)).toBeNull();
  expect(query(element, ".chat-details-session > summary")).toBeNull();
  const openChanges = vi.fn();
  await update(element, { onOpenSessionDiff: openChanges });
  expect(detailsGroup(element, "pull-requests")).toBeNull();
  expect(detailsGroup(element, "environment")).toBeNull();
  expect(openChanges).not.toHaveBeenCalled();
  await update(element, { onOpenSessionDiff: undefined });
  expect(linkedWork(element)).toBeNull();
  await update(element, { pullRequests });
  expect(detailsGroup(element, "pull-requests")?.open).toBe(true);
});
it("keeps compaction busy until the owning request settles and uses the current callback", async () => {
  const pending = createDeferred();
  const compact = vi.fn(() => pending.promise);
  const { gateway, publish } = createApplicationGateway();
  const request = createGatewayRequestMock(() => ({
    sessions: [
      {
        key: "agent:main:details",
        contextWeight: {
          source: "run",
          generatedAt: 1,
          systemPrompt: { chars: 4000, projectContextChars: 0, nonProjectContextChars: 4000 },
          injectedWorkspaceFiles: [],
          skills: { promptChars: 0, entries: [] },
          tools: { listChars: 0, schemaChars: 0, entries: [] },
        },
      },
    ],
  }));
  publish({ ...gateway.snapshot, phase: "connected", client: createTestGatewayClient(request) });
  const view = mountSolid(() =>
    createComponent(ChatContextPanel, {
      presented: true,
      details: {
        currentAgentId: "main",
        pullRequestsGateway: gateway,
        selectedSession: session({
          totalTokens: 50000,
          contextTokens: 100000,
        }),
        onCompact: compact,
      },
    }),
  );
  const element = view.container.querySelector("openclaw-chat-context-panel")!;
  await element.updateComplete;
  await waitForSolid(() =>
    expect(query<HTMLButtonElement>(element, ".chat-context__compact")?.disabled).toBe(false),
  );
  const button = query<HTMLButtonElement>(element, ".chat-context__compact")!;
  try {
    button.click();
    await waitForSolid(() => {
      expect(button.disabled).toBe(true);
      expect(button.textContent).toContain("Compacting");
    });
    expect(compact).toHaveBeenCalledOnce();
    button.click();
    expect(compact).toHaveBeenCalledOnce();
  } finally {
    pending.resolve();
  }
  await waitForSolid(() => expect(button.disabled).toBe(false));
  const replacement = vi.fn(async () => {});
  element.details = { ...element.details!, onCompact: replacement };
  await element.updateComplete;
  button.click();
  await waitForSolid(() => expect(replacement).toHaveBeenCalledOnce());
  expect(compact).toHaveBeenCalledOnce();
});
it("keeps immutable creator, mutable owner and participants distinct without claiming live presence", async () => {
  const element = await mount({
    selectedSession: session({
      createdActor: { type: "human", id: "creator", label: "Original creator" },
      owner: { actor: { type: "human", id: "owner", label: "Current owner" } },
      participants: [{ identity: { type: "profile", id: "participant" }, label: "Contributor" }],
      participantCount: 3,
    }),
  });
  expect(domText(element, ".chat-details__creator")).toContain("Original creator");
  expect(domText(element, ".chat-details__creator")).not.toContain("Current owner");
  expect(domText(element, ".chat-details__participants")).toContain("Current owner");
  expect(element.textContent).toContain("3 participants");
  expect(element.textContent).toContain("2 more participants");
  expect(element.textContent).not.toMatch(/online|viewers/i);
  expect(query<HTMLDetailsElement>(element, ".chat-details__participants")?.open).toBe(false);
  const replaceOwner = async (actor: NonNullable<GatewaySessionRow["owner"]>["actor"]) => {
    await update(element, {
      selectedSession: { ...element.props!.selectedSession!, owner: { actor } },
    });
  };
  for (const desktop of [false, true]) {
    element.desktop = desktop;
    await update(element, {
      desktopPresentation: desktop
        ? { peopleLabel: "People", outputsLabel: "Outputs", subagentsWorkingLabel: "Working" }
        : undefined,
      desktopDisclosures: { expanded: { people: true }, onExpandedChange() {} },
    });
    const owners: NonNullable<GatewaySessionRow["owner"]>["actor"][] = [
      { type: "human", id: "replacement", label: "Replacement owner" },
      { type: "agent", id: "fallback-id" },
      { type: "system" },
    ];
    for (const actor of owners) {
      await replaceOwner(actor);
      expect(domText(element, ".chat-details__person")).toBe(
        `Owner${actor.label || actor.id || actor.type}`,
      );
      expect(domText(element, ".chat-details__creator")).toContain("Original creator");
    }
  }
  await replaceOwner({
    type: "human",
    id: "projected",
    label: "Projected owner",
    identity: { type: "profile", id: "projected" },
  });
  expect(domText(element, ".chat-details-people")).toContain("Projected owner");
  expect(query(element, ".chat-details__person")).toBeNull();
});
it("shows participant controls only while the session has participants", async () => {
  const element = await mount();
  expect(query(element, ".chat-details__meta-actions")).toBeNull();
  await update(element, {
    selectedSession: {
      ...element.props!.selectedSession!,
      participants: [{ identity: { type: "profile", id: "participant" }, label: "Contributor" }],
    },
  });
  expect(domText(element, ".chat-details__participants")).toContain("1 participants");
  await update(element, {
    selectedSession: { ...element.props!.selectedSession!, participantCount: 0 },
  });
  expect(query(element, ".chat-details__meta-actions")).toBeNull();
});
it("uses the current PR renderer and preserves CI session identity and branch dismissal", async () => {
  const element = await mount({
    pullRequestsSessionId: "incarnation-7",
    pullRequests: [
      {
        number: 7,
        owner: "example",
        repo: "project",
        branch: "feature",
        title: "A compact PR title",
        url: "https://github.com/example/project/pull/7",
        state: "open",
        additions: 84,
        deletions: 41,
      },
    ],
  });
  await waitForSolid(() => expect(domText(element, ".chat-pr__title")).toBe("A compact PR title"));
  const link = query(element, ".chat-pr__link")!;
  expect(link.getAttribute("href")).toBe("https://github.com/example/project/pull/7");
  const automation = query(element, "openclaw-chat-ci-automation");
  expect(automation).toHaveProperty("sessionId", "incarnation-7");
  expect(automation).toHaveProperty("presented", false);
  query<HTMLButtonElement>(element, ".chat-pr__actions button")!.click();
  flush();
  const menu = query(element, ".chat-pr__actions")!;
  for (const fact of ["example/project", "#7", "Open", "+84", "−41"]) {
    expect(menu.textContent).toContain(fact);
  }
  await waitForSolid(() =>
    expect(query(menu, "button")?.getAttribute("aria-expanded")).toBe("true"),
  );
  query<HTMLButtonElement>(menu, '[data-value="monitoring"]')!.click();
  flush();
  expect(query(element, "openclaw-chat-ci-automation")).toBe(automation);
  expect(automation).toHaveProperty("presented", true);
  const branch = {
    owner: "example",
    repo: "project",
    branch: "feature",
    createUrl: "https://github.com/example/project/compare/feature",
  };
  await update(element, {
    pullRequests: [],
    pullRequestsBranch: branch,
    pullRequestsBranchDismissed: true,
  });
  expect(query(element, ".chat-pr")).toBeNull();
});
it("projects direct active children through the live observer with stable rounded-avatar seeds", async () => {
  const child = {
    key: "agent:main:subagent:details",
    kind: "direct" as const,
    label: "Verify layout",
    spawnedBy: "agent:main:details",
    hasActiveRun: true,
    activeRunIds: ["run-1"],
    sessionId: "child-1",
  };
  const element = await mount({
    selectedSession: session({ hasActiveSubagentRun: true }),
    subagentSessions: [child],
    subagentSessionsHydrated: true,
  });
  const live = await activity(element);
  expect(live.rows[0]?.session).toBe(child);
  expect(query(live, ".chat-details__agent-avatar")?.getAttribute("style")).toContain(
    String(fnv1aUtf16(child.key) % 360),
  );
  expect(domText(live, ".chat-subagent-activity__name")).toBe("Verify layout");
  element.presented = false;
  await element.updateComplete;
  expect(query(element, "openclaw-chat-subagent-activity")).toBeNull();
});

it("groups every direct subagent with counts, live activity first, and a bounded preview", async () => {
  const parent = "agent:main:details";
  const child = (slug: string, state: Partial<GatewaySessionRow>): GatewaySessionRow => ({
    key: `agent:main:subagent:${slug}`,
    kind: "direct",
    label: slug,
    spawnedBy: parent,
    ...state,
  });
  const openSubagents = vi.fn();
  const element = await mount({
    selectedSession: session({ key: parent, hasActiveSubagentRun: true }),
    subagentSessions: [
      child("review", {
        hasActiveRun: true,
        activeRunIds: ["run-1"],
        startedAt: Date.now() - 65_000,
        observerDigest: {
          runId: "run-1",
          revision: 1,
          updatedAt: 1,
          headline: "Comparing themes",
          health: "on-track",
        },
      }),
      child("queued", { status: "queued" }),
      child("docs", { status: "done" }),
      child("bench", { status: "timeout" }),
      child("lint", { status: "killed" }),
      child("archived", { status: "done", archived: true }),
      child("other-parent", { status: "done", spawnedBy: "agent:main:elsewhere" }),
    ],
    subagentSessionsHydrated: true,
    onOpenSubagents: openSubagents,
  });
  expect(detailsGroup(element, "processes")).toBeNull();
  const lane = detailsGroup(element, "subagents")!;
  expect(lane.open).toBe(true);
  const summary = query(lane, "summary")!;
  expect(domText(summary, ".chat-details__tally-summary")).toBe(
    "1 running · 1 queued · 1 done · 1 failed · 1 stopped",
  );
  // The bar sits in the heading so a collapsed group still shows it.
  expect(
    [...summary.querySelectorAll<HTMLElement>(".chat-details__tally-segment")].map(
      (segment) => segment.dataset.state,
    ),
  ).toEqual(["done", "failed", "stopped", "running", "queued"]);
  const live = await activity(lane);
  const shownKeys = () =>
    [...live.querySelectorAll<HTMLElement>("[data-subagent-session-key]")].map((row) =>
      row.dataset.subagentSessionKey?.replace("agent:main:subagent:", ""),
    );
  expect(shownKeys()).toEqual(["review", "queued", "bench"]);
  const more = query<HTMLButtonElement>(lane, ".chat-details__more")!;
  expect(more.textContent).toBe("Show 2 more");
  more.click();
  await live.updateComplete;
  expect(shownKeys()).toEqual(["review", "queued", "bench", "lint", "docs"]);
  expect(more.textContent).toBe("Show less");
  expect(
    live
      .querySelector('[data-subagent-session-key="agent:main:subagent:bench"]')
      ?.querySelector(".chat-subagent-activity__status")?.textContent,
  ).toBe("Failed");
  const review = query(live, '[data-subagent-session-key="agent:main:subagent:review"]')!;
  expect(domText(review, ".chat-subagent-activity__status")).toBe("Comparing themes");
  expect(domText(review, ".chat-subagent-activity__elapsed-compact")).not.toBe("");
  query<HTMLButtonElement>(lane, ".chat-details__navigation")!.click();
  expect(openSubagents).toHaveBeenCalledOnce();
  element.presented = false;
  await element.updateComplete;
  query<HTMLButtonElement>(lane, ".chat-details__navigation")?.click();
  expect(openSubagents).toHaveBeenCalledOnce();
});

it("shows finished subagents after the parent stops waiting and omits the group without any", async () => {
  const element = await mount({
    subagentSessions: [
      {
        key: "agent:main:subagent:done",
        kind: "direct",
        status: "done",
        spawnedBy: "agent:main:details",
      },
    ],
    subagentSessionsHydrated: true,
  });
  const group = detailsGroup(element, "subagents")!;
  expect(domText(group, ".chat-details__tally-summary")).toBe("1 done");
  expect(query(group, ".chat-details__more")).toBeNull();
  const live = await activity(group);
  expect(domText(live, ".chat-subagent-activity__status")).toBe("Completed");
  await update(element, { subagentSessionsHydrated: false });
  expect(detailsGroup(element, "subagents")).toBeNull();
});

it("shows live environment facts without duplicating composer context", async () => {
  const element = await mount({
    detailsWorkspace: workspace(undefined, "/workspace/project"),
    selectedSession: session({
      execNode: "Design workstation",
      model: "demo-model",
      totalTokens: 64000,
      totalTokensFresh: true,
      contextTokens: 128000,
      inputTokens: 1200,
      outputTokens: 450,
    }),
  });
  const environment = detailsGroup(element, "environment")!;
  expect(environment.textContent).toContain("feature/details");
  expect(environment.textContent).not.toContain("Design workstation");
  expect(environment.textContent).not.toContain("/workspace/project");
  expect(query(environment, '[aria-label="Copy path"]')).toBeNull();
  expect(query(element, ".chat-details__context")).toBeNull();
});

it.each([
  "/home/private-user/.openclaw/workspace/",
  "C:\\Users\\private-user\\.openclaw\\workspace\\",
])("keeps an unlabelled workspace's private parent path out of Details: %s", async (root) => {
  const element = await mount({
    detailsWorkspace: { root, label: null, branch: "feature/details" },
  });
  const environment = detailsGroup(element, "environment")!;
  expect(environment.textContent).toContain("feature/details");
  expect(environment.textContent).not.toContain(root);
  expect(environment.textContent).not.toContain("private-user");
  const openProject = vi.fn();
  const view = mountSolid(() =>
    createComponent(ChatDetailsEnvironmentMobile, {
      details: { selectedSession: undefined, detailsWorkspace: { root, label: null } },
      presented: true,
      onOpenProject: openProject,
    }),
  );
  const project = query<HTMLButtonElement>(view.container, "button")!;
  expect(project.textContent).toBe("workspace");
  expect(view.container.textContent).not.toContain(root);
  expect(view.container.textContent).not.toContain("private-user");
  for (const metadata of [
    ...environment.querySelectorAll("[title], [aria-label]"),
    ...view.container.querySelectorAll("[title], [aria-label]"),
  ]) {
    expect(metadata.getAttribute("title") ?? "").not.toContain("private-user");
    expect(metadata.getAttribute("aria-label") ?? "").not.toContain("private-user");
  }
  project.click();
  expect(openProject).toHaveBeenCalledOnce();
});

it("demands mobile changes only while presented and retires native navigation callbacks when hidden", () => {
  const request = vi.fn();
  const openMachine = vi.fn();
  const openChanges = vi.fn();
  const [presented, setPresented] = createSignal(true);
  const [selected, setSession] = createSignal(session({ execNode: "Gateway machine" }));
  const view = mountSolid(() =>
    createComponent(ChatDetailsEnvironmentMobile, {
      details: {
        get selectedSession() {
          return selected();
        },
        detailsWorkspace: { root: "/workspace/project", label: null, branch: "feature/details" },
      },
      get presented() {
        return presented();
      },
      onRequestUncommitted: request,
      onOpenMachine: openMachine,
      onOpenUncommitted: openChanges,
      uncommitted: {
        sessionKey: "agent:main:details",
        baseRef: "HEAD",
        branch: "feature/details",
        files: [{ path: "example.ts", status: "modified", additions: 3, deletions: 1 }],
        additions: 3,
        deletions: 1,
      },
    }),
  );
  flush();
  expect(request).toHaveBeenCalledOnce();
  expect(view.container.textContent).not.toContain("Gateway machine");
  setSession(
    session({
      placement: createActiveSessionPlacement({
        createdAtMs: 100_000,
        updatedAtMs: 300_000,
        stateChangedAtMs: 300_000,
        workspaceBaseManifestRef: "base-manifest",
        remoteWorkspaceDir: "/worker/repo",
        runner: { kind: "device", status: "available" },
      }),
    }),
  );
  flush();
  const buttons = Array.from(view.container.querySelectorAll<HTMLButtonElement>("button"));
  const machine = buttons.find((button) => button.textContent === "worker:device")!;
  const changes = buttons.find((button) => button.textContent?.includes("Changes"))!;
  expect(changes.textContent).toContain("+3");
  expect(changes.textContent).toContain("−1");
  machine.click();
  changes.click();
  expect(openMachine).toHaveBeenCalledOnce();
  expect(openChanges).toHaveBeenCalledOnce();
  setPresented(false);
  flush();
  machine.click();
  changes.click();
  expect(request).toHaveBeenCalledOnce();
  expect(openMachine).toHaveBeenCalledOnce();
  expect(openChanges).toHaveBeenCalledOnce();
  setPresented(true);
  flush();
  expect(request).toHaveBeenCalledTimes(2);
});

it.each([false, true])(
  "keeps branch publication on the existing Environment row (desktop=%s)",
  async (desktop) => {
    const branch = sessionBranch({
      branch: "feature/environment-publication",
      additions: 7,
      deletions: 2,
    });
    const onPublish = vi.fn();
    const onOpenSessionDiff = vi.fn();
    const element = await mount({
      detailsWorkspace: workspace(branch.branch),
      pullRequestsBranch: branch,
      githubPublication: publication({ onPublish }),
      onOpenSessionDiff,
    });
    element.desktop = desktop;
    await element.updateComplete;
    const environment = detailsGroup(element, "environment")!;
    await waitForSolid(() =>
      expect(domText(environment, "button.chat-pr__create")).toBe("Create PR"),
    );
    const create = query<HTMLButtonElement>(environment, "button.chat-pr__create");
    expect(environment.textContent).toContain("+7");
    expect(environment.textContent).toContain("−2");
    expect(query(element, '[data-details-group="pull-requests"] .chat-pr--unpublished')).toBeNull();
    create!.click();
    expect(onPublish).toHaveBeenCalledOnce();
    query<HTMLButtonElement>(environment, ".chat-pr__diff")!.click();
    expect(onOpenSessionDiff).toHaveBeenCalledOnce();
    await update(element, {
      pullRequestsBranch: { ...branch, additions: undefined, deletions: undefined },
    });
    expect(query(environment, ".chat-pr__diff")).toBeNull();
    expect(domText(environment, "button.chat-pr__create")).toBe("Create PR");
    expect(onOpenSessionDiff).toHaveBeenCalledOnce();
    await update(element, {
      pullRequestsBranch: undefined,
      githubPublication: undefined,
      pullRequests: [pullRequest()],
    });
    await waitForSolid(() =>
      expect(query(element, '[data-details-group="pull-requests"] .chat-pr__link')).not.toBeNull(),
    );
    expect(query(environment, ".chat-pr__publication-actions")).toBeNull();
  },
);

it("keeps local Changes after publication and accepts a confirmed clean working tree", async () => {
  const branch = sessionBranch({ branch: "feature/published", additions: 7, deletions: 2 });
  const element = await mount({
    detailsWorkspace: workspace(branch.branch),
    pullRequestsBranch: branch,
    onOpenSessionDiff: vi.fn(),
    environment: {
      uncommitted: {
        sessionKey: "agent:main:details",
        files: [{ path: "app.ts", status: "modified", additions: 7, deletions: 2 }],
        additions: 7,
        deletions: 2,
      },
    },
    githubPublication: publication({
      result: {
        requestId: "published",
        status: "published",
        publisher: { source: "system-configured", accountId: 1, login: "system-bot" },
        repository: "openclaw/openclaw",
        branch: branch.branch,
        headCommit: "a".repeat(40),
        url: "https://github.com/openclaw/openclaw/pull/44",
      },
    }),
  });
  const environment = detailsGroup(element, "environment")!;
  expect(environment.textContent).toContain(branch.branch);
  expect(query(environment, ".chat-pr__publication-actions")).toBeNull();
  expect(domText(environment, ".chat-pr__diff")).toContain("+7");
  expect(domText(environment, ".chat-pr__diff")).toContain("−2");
  await update(element, {
    environment: {
      uncommitted: { sessionKey: "agent:main:details", files: [], additions: 0, deletions: 0 },
    },
  });
  expect(query(environment, ".chat-pr__diff")).toBeNull();
  expect(environment.textContent).toContain(branch.branch);
  await waitForSolid(() =>
    expect(
      query(element, '[data-details-group="pull-requests"] a[href$="/pull/44"]'),
    ).not.toBeNull(),
  );
});

it("keeps unresolved publication recovery and a different unpublished branch available", async () => {
  const failed = publication({
    result: {
      requestId: "failed",
      status: "failed",
      code: "unavailable",
      message: "Publication failed.",
      nextAction: "Check publication.",
    },
  });
  const element = await mount({
    detailsWorkspace: workspace("feature/current"),
    pullRequests: [pullRequest({ branch: "feature/current" })],
    githubPublication: failed,
  });
  const environment = detailsGroup(element, "environment")!;
  expect(query(environment, ".chat-pr__publication-actions")).toBeNull();
  await update(element, {
    githubPublication: publication({
      locked: true,
    }),
  });
  await waitForSolid(() =>
    expect(domText(environment, ".chat-pr__create")).toBe("Check publication"),
  );
  await update(element, {
    githubPublication: failed,
    pullRequestsBranch: sessionBranch({ branch: "feature/next", additions: 3 }),
  });
  await waitForSolid(() => expect(domText(environment, ".chat-pr__create")).toBe("Retry"));
  expect(domText(environment, ".chat-pr__diff")).toContain("+3");
});

it.each([false, true])(
  "shows only textual Changes facts without binary metadata (mobile=%s)",
  (mobile) => {
    // jsdom has no Web Animations API; arrival motion has separate browser proof.
    const animate = Object.getOwnPropertyDescriptor(Element.prototype, "animate");
    Object.defineProperty(Element.prototype, "animate", {
      configurable: true,
      value: () => ({ cancel() {} }),
    });
    const [uncommitted, setUncommitted] = createSignal<SessionsDiffResult>();
    const open = vi.fn();
    const inputDetails = details({ selectedSession: undefined });
    const view = mountSolid(() =>
      createComponent(mobile ? ChatDetailsEnvironmentMobile : ChatDetailsEnvironment, {
        details: inputDetails,
        presented: true,
        get uncommitted() {
          return uncommitted();
        },
        onOpenUncommitted: open,
      }),
    );
    onTestFinished(() => {
      view.unmount();
      restorePropertyDescriptor(Element.prototype, "animate", animate);
    });
    const row = () =>
      [...view.container.querySelectorAll<HTMLButtonElement>("button")].find((button) =>
        button.textContent?.includes("Changes"),
      );
    const result: SessionsDiffResult = {
      sessionKey: inputDetails.sessionKey,
      additions: 0,
      deletions: 0,
      files: [],
    };
    const binary = {
      path: "image.png",
      status: "modified" as const,
      additions: 0,
      deletions: 0,
      binary: true,
    };
    const text = { path: "app.ts", status: "modified" as const, additions: 3, deletions: 1 };
    expect(row()).toBeUndefined();
    for (const data of [
      result,
      { ...result, files: [binary] },
      { ...result, files: [binary], truncated: true },
    ]) {
      setUncommitted(data);
      flush();
      expect(row()).toBeUndefined();
      expect(
        query(view.container, "[data-details-group=environment], .chat-environment-mobile"),
      ).toBeNull();
    }
    for (const data of [
      { ...result, additions: 3, files: [{ ...text, deletions: 0 }] },
      { ...result, deletions: 1, files: [{ ...text, additions: 0 }] },
      { ...result, additions: 3, deletions: 1, files: [text, binary], truncated: true },
    ]) {
      setUncommitted(data);
      flush();
      expect(row()).toBeDefined();
      expect(row()?.querySelector('[aria-label="Binary file"]')).toBeNull();
      expect(row()?.textContent).not.toContain("…");
      row()!.click();
    }
    expect(open).toHaveBeenCalledTimes(3);
    setUncommitted({
      ...result,
      additions: 3,
      files: [text],
      unavailableReason: "unknown_session",
    });
    flush();
    expect(row()).toBeUndefined();
  },
);

it("reloads missing branchless facts even when Environment was collapsed", async () => {
  const result: SessionsDiffResult = {
    sessionKey: "agent:main:details",
    additions: 1,
    deletions: 0,
    files: [],
  };
  const [uncommitted, setUncommitted] = createSignal<SessionsDiffResult | undefined>(result);
  const stop = vi.fn();
  const retain = vi.fn(() => stop);
  const view = mountSolid(() =>
    createComponent(ChatDetailsEnvironment, {
      details: details({ selectedSession: undefined }),
      presented: true,
      expanded: false,
      get uncommitted() {
        return uncommitted();
      },
      onRequestUncommitted: retain,
    }),
  );
  expect(retain).not.toHaveBeenCalled();
  setUncommitted(undefined);
  await waitForSolid(() => expect(retain).toHaveBeenCalledOnce());
  expect(detailsGroup(view.container, "environment")).toBeNull();
  setUncommitted(result);
  await waitForSolid(() => expect(stop).toHaveBeenCalledOnce());
  expect(detailsGroup(view.container, "environment")).not.toBeNull();
});
