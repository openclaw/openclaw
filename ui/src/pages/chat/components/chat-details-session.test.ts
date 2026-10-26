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

async function mount(overrides: Partial<ChatDetailsProps> = {}) {
  const value: ChatDetailsProps = {
    sessionKey: "agent:main:details",
    currentAgentId: "main",
    messages: [],
    selectedSession: { key: "agent:main:details", kind: "direct" },
    ...overrides,
  };
  const view = mountSolid(() =>
    createComponent(ChatDetailsSession, { props: value, presented: true }),
  );
  const element = view.container.querySelector("openclaw-chat-details-session")!;
  await element.updateComplete;
  return element;
}
it("omits empty linked-work disclosures and opens arriving pull requests", async () => {
  const element = await mount();
  expect(
    element.querySelector(
      '[data-details-group="pull-requests"], [data-details-group="automations"], [data-details-group="subagents"], [data-details-group="processes"]',
    ),
  ).toBeNull();
  element.props = {
    ...element.props!,
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
  };
  await element.updateComplete;
  const group = element.querySelector<HTMLDetailsElement>('[data-details-group="pull-requests"]')!;
  expect(group.open).toBe(true);
  expect(group.querySelector("summary")?.textContent).toContain("Pull requests");
  group.open = false;
  group.dispatchEvent(new Event("toggle"));
  flush();
  element.props = { ...element.props! };
  await element.updateComplete;
  expect(group.open).toBe(false);
  const pullRequests = element.props!.pullRequests;
  element.props = { ...element.props!, pullRequests: [] };
  await element.updateComplete;
  expect(
    element.querySelector(
      '[data-details-group="pull-requests"], [data-details-group="automations"], [data-details-group="subagents"], [data-details-group="processes"]',
    ),
  ).toBeNull();
  expect(element.querySelector(".chat-details-session > summary")).toBeNull();
  const openChanges = vi.fn();
  element.props = { ...element.props!, onOpenSessionDiff: openChanges };
  await element.updateComplete;
  expect(element.querySelector('[data-details-group="pull-requests"]')).toBeNull();
  expect(element.querySelector('[data-details-group="environment"]')).toBeNull();
  expect(openChanges).not.toHaveBeenCalled();
  element.props = { ...element.props!, onOpenSessionDiff: undefined };
  await element.updateComplete;
  expect(
    element.querySelector(
      '[data-details-group="pull-requests"], [data-details-group="automations"], [data-details-group="subagents"], [data-details-group="processes"]',
    ),
  ).toBeNull();
  element.props = { ...element.props!, pullRequests };
  await element.updateComplete;
  expect(
    element.querySelector<HTMLDetailsElement>('[data-details-group="pull-requests"]')?.open,
  ).toBe(true);
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
        selectedSession: {
          key: "agent:main:details",
          kind: "direct",
          totalTokens: 50000,
          contextTokens: 100000,
        },
        onCompact: compact,
      },
    }),
  );
  const element = view.container.querySelector("openclaw-chat-context-panel")!;
  await element.updateComplete;
  await waitForSolid(() =>
    expect(element.querySelector<HTMLButtonElement>(".chat-context__compact")?.disabled).toBe(
      false,
    ),
  );
  const button = element.querySelector<HTMLButtonElement>(".chat-context__compact")!;
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
    selectedSession: {
      key: "agent:main:details",
      kind: "direct",
      createdActor: { type: "human", id: "creator", label: "Original creator" },
      owner: { actor: { type: "human", id: "owner", label: "Current owner" } },
      participants: [{ identity: { type: "profile", id: "participant" }, label: "Contributor" }],
      participantCount: 3,
    },
  });
  expect(element.querySelector(".chat-details__creator")?.textContent).toContain(
    "Original creator",
  );
  expect(element.querySelector(".chat-details__creator")?.textContent).not.toContain(
    "Current owner",
  );
  expect(element.querySelector(".chat-details__participants")?.textContent).toContain(
    "Current owner",
  );
  expect(element.textContent).toContain("3 participants");
  expect(element.textContent).toContain("2 more participants");
  expect(element.textContent).not.toMatch(/online|viewers/i);
  expect(element.querySelector<HTMLDetailsElement>(".chat-details__participants")?.open).toBe(
    false,
  );
  const replaceOwner = async (actor: NonNullable<GatewaySessionRow["owner"]>["actor"]) => {
    element.props = {
      ...element.props!,
      selectedSession: { ...element.props!.selectedSession!, owner: { actor } },
    };
    await element.updateComplete;
  };
  for (const desktop of [false, true]) {
    element.desktop = desktop;
    element.props = {
      ...element.props!,
      desktopPresentation: desktop
        ? { peopleLabel: "People", outputsLabel: "Outputs", subagentsWorkingLabel: "Working" }
        : undefined,
      desktopDisclosures: { expanded: { people: true }, onExpandedChange() {} },
    };
    await element.updateComplete;
    const owners: NonNullable<GatewaySessionRow["owner"]>["actor"][] = [
      { type: "human", id: "replacement", label: "Replacement owner" },
      { type: "agent", id: "fallback-id" },
      { type: "system" },
    ];
    for (const actor of owners) {
      await replaceOwner(actor);
      expect(element.querySelector(".chat-details__person")?.textContent).toBe(
        `Owner${actor.label || actor.id || actor.type}`,
      );
      expect(element.querySelector(".chat-details__creator")?.textContent).toContain(
        "Original creator",
      );
    }
  }
  await replaceOwner({
    type: "human",
    id: "projected",
    label: "Projected owner",
    identity: { type: "profile", id: "projected" },
  });
  await vi.dynamicImportSettled();
  await waitForSolid(() =>
    expect(element.querySelector(".chat-details-people")?.textContent).toContain("Projected owner"),
  );
  expect(element.querySelector(".chat-details__person")).toBeNull();
});
it("shows participant controls only while the session has participants", async () => {
  const element = await mount();
  expect(element.querySelector(".chat-details__meta-actions")).toBeNull();
  element.props = {
    ...element.props!,
    selectedSession: {
      ...element.props!.selectedSession!,
      participants: [{ identity: { type: "profile", id: "participant" }, label: "Contributor" }],
    },
  };
  await element.updateComplete;
  expect(element.querySelector(".chat-details__participants")?.textContent).toContain(
    "1 participants",
  );
  element.props = {
    ...element.props!,
    selectedSession: { ...element.props!.selectedSession!, participantCount: 0 },
  };
  await element.updateComplete;
  expect(element.querySelector(".chat-details__meta-actions")).toBeNull();
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
  await waitForSolid(() =>
    expect(element.querySelector(".chat-pr__title")?.textContent).toBe("A compact PR title"),
  );
  const link = element.querySelector(".chat-pr__link")!;
  expect(link.getAttribute("href")).toBe("https://github.com/example/project/pull/7");
  expect(element.querySelector("openclaw-chat-ci-automation")).toBeNull();
  element.querySelector<HTMLButtonElement>(".chat-pr__actions button")!.click();
  flush();
  const menu = element.querySelector(".chat-pr__actions")!;
  for (const fact of ["example/project", "#7", "Open", "+84", "−41"]) {
    expect(menu.textContent).toContain(fact);
  }
  await waitForSolid(() =>
    expect(menu.querySelector("button")?.getAttribute("aria-expanded")).toBe("true"),
  );
  menu.querySelector<HTMLButtonElement>('[data-value="monitoring"]')!.click();
  // The monitoring panel loads a second lazy module on first entry.
  await waitForSolid(
    () => expect(element.querySelector("openclaw-chat-ci-automation")).not.toBeNull(),
    { timeout: 5_000 },
  );
  const automation = element.querySelector("openclaw-chat-ci-automation");
  expect(automation).toHaveProperty("sessionId", "incarnation-7");
  expect(automation).toHaveProperty("presented", true);
  menu.querySelector<HTMLButtonElement>("button")!.click();
  await waitForSolid(() => expect(automation).toHaveProperty("presented", false));
  expect(element.querySelector("openclaw-chat-ci-automation")).toBe(automation);
  const branch = {
    owner: "example",
    repo: "project",
    branch: "feature",
    createUrl: "https://github.com/example/project/compare/feature",
  };
  element.props = {
    ...element.props!,
    pullRequests: [],
    pullRequestsBranch: branch,
    pullRequestsBranchDismissed: true,
  };
  await element.updateComplete;
  expect(element.querySelector(".chat-pr")).toBeNull();
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
    selectedSession: { key: "agent:main:details", kind: "direct", hasActiveSubagentRun: true },
    subagentSessions: [child],
    subagentSessionsHydrated: true,
  });
  // The live activity module is loaded on the first visible child group.
  await waitForSolid(
    () => expect(element.querySelector("openclaw-chat-subagent-activity")).not.toBeNull(),
    { timeout: 5_000 },
  );
  const live = element.querySelector<ChatSubagentActivityLive>("openclaw-chat-subagent-activity")!;
  await live.updateComplete;
  expect(live.rows[0]?.session).toBe(child);
  expect(live.querySelector(".chat-details__agent-avatar")?.getAttribute("style")).toContain(
    String(fnv1aUtf16(child.key) % 360),
  );
  expect(live.querySelector(".chat-subagent-activity__name")?.textContent).toBe("Verify layout");
  element.presented = false;
  await element.updateComplete;
  expect(element.querySelector("openclaw-chat-subagent-activity")).toBeNull();
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
    selectedSession: { key: parent, kind: "direct", hasActiveSubagentRun: true },
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
  expect(element.querySelector('[data-details-group="processes"]')).toBeNull();
  const lane = element.querySelector<HTMLDetailsElement>('[data-details-group="subagents"]')!;
  expect(lane.open).toBe(true);
  const summary = lane.querySelector("summary")!;
  expect(summary.querySelector(".chat-details__tally-summary")?.textContent).toBe(
    "1 running · 1 queued · 1 done · 1 failed · 1 stopped",
  );
  // The bar sits in the heading so a collapsed group still shows it.
  expect(
    [...summary.querySelectorAll<HTMLElement>(".chat-details__tally-segment")].map(
      (segment) => segment.dataset.state,
    ),
  ).toEqual(["done", "failed", "stopped", "running", "queued"]);
  await waitForSolid(() =>
    expect(lane.querySelector("openclaw-chat-subagent-activity")).not.toBeNull(),
  );
  const live = lane.querySelector<ChatSubagentActivityLive>("openclaw-chat-subagent-activity")!;
  await live.updateComplete;
  const shownKeys = () =>
    [...live.querySelectorAll<HTMLElement>("[data-subagent-session-key]")].map((row) =>
      row.dataset.subagentSessionKey?.replace("agent:main:subagent:", ""),
    );
  expect(shownKeys()).toEqual(["review", "queued", "bench"]);
  const more = lane.querySelector<HTMLButtonElement>(".chat-details__more")!;
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
  const review = live.querySelector('[data-subagent-session-key="agent:main:subagent:review"]')!;
  expect(review.querySelector(".chat-subagent-activity__status")?.textContent).toBe(
    "Comparing themes",
  );
  expect(review.querySelector(".chat-subagent-activity__elapsed-compact")?.textContent).not.toBe(
    "",
  );
  lane.querySelector<HTMLButtonElement>(".chat-details__navigation")!.click();
  expect(openSubagents).toHaveBeenCalledOnce();
  element.presented = false;
  await element.updateComplete;
  lane.querySelector<HTMLButtonElement>(".chat-details__navigation")?.click();
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
  const group = element.querySelector('[data-details-group="subagents"]')!;
  expect(group.querySelector(".chat-details__tally-summary")?.textContent).toBe("1 done");
  expect(group.querySelector(".chat-details__more")).toBeNull();
  await waitForSolid(() =>
    expect(group.querySelector("openclaw-chat-subagent-activity")).not.toBeNull(),
  );
  const live = group.querySelector<ChatSubagentActivityLive>("openclaw-chat-subagent-activity")!;
  await live.updateComplete;
  expect(live.querySelector(".chat-subagent-activity__status")?.textContent).toBe("Completed");
  element.props = { ...element.props!, subagentSessionsHydrated: false };
  await element.updateComplete;
  expect(element.querySelector('[data-details-group="subagents"]')).toBeNull();
});

it("shows live environment facts without duplicating composer context", async () => {
  const element = await mount({
    detailsWorkspace: { label: "project", root: "/workspace/project", branch: "feature/details" },
    selectedSession: {
      key: "agent:main:details",
      kind: "direct",
      execNode: "Design workstation",
      model: "demo-model",
      totalTokens: 64000,
      totalTokensFresh: true,
      contextTokens: 128000,
      inputTokens: 1200,
      outputTokens: 450,
    },
  });
  await vi.dynamicImportSettled();
  const environment = element.querySelector('[data-details-group="environment"]')!;
  await waitForSolid(() => expect(environment.textContent).toContain("feature/details"));
  expect(environment.textContent).not.toContain("Design workstation");
  expect(environment.textContent).not.toContain("/workspace/project");
  expect(environment.querySelector('[aria-label="Copy path"]')).toBeNull();
  expect(element.querySelector(".chat-details__context")).toBeNull();
});

it.each([
  "/home/private-user/.openclaw/workspace/",
  "C:\\Users\\private-user\\.openclaw\\workspace\\",
])("keeps an unlabelled workspace's private parent path out of Details: %s", async (root) => {
  const element = await mount({
    detailsWorkspace: { root, label: null, branch: "feature/details" },
  });
  const environment = element.querySelector('[data-details-group="environment"]')!;
  await waitForSolid(() => expect(environment.textContent).toContain("feature/details"));
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
  const project = view.container.querySelector<HTMLButtonElement>("button")!;
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
  const [session, setSession] = createSignal<GatewaySessionRow>({
    key: "agent:main:details",
    kind: "direct",
    execNode: "Gateway machine",
  });
  const view = mountSolid(() =>
    createComponent(ChatDetailsEnvironmentMobile, {
      details: {
        get selectedSession() {
          return session();
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
  setSession({
    key: "agent:main:details",
    kind: "direct",
    placement: createActiveSessionPlacement({
      createdAtMs: 100_000,
      updatedAtMs: 300_000,
      stateChangedAtMs: 300_000,
      workspaceBaseManifestRef: "base-manifest",
      remoteWorkspaceDir: "/worker/repo",
      runner: { kind: "device", status: "available" },
    }),
  });
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
      detailsWorkspace: { root: "/synthetic/project", label: "project", branch: branch.branch },
      pullRequestsBranch: branch,
      githubPublication: publication({ onPublish }),
      onOpenSessionDiff,
    });
    element.desktop = desktop;
    await element.updateComplete;
    const environment = element.querySelector('[data-details-group="environment"]')!;
    await waitForSolid(() =>
      expect(environment.querySelector("button.chat-pr__create")?.textContent).toBe("Create PR"),
    );
    const create = environment.querySelector<HTMLButtonElement>("button.chat-pr__create");
    expect(environment.textContent).toContain("+7");
    expect(environment.textContent).toContain("−2");
    expect(
      element.querySelector('[data-details-group="pull-requests"] .chat-pr--unpublished'),
    ).toBeNull();
    create!.click();
    expect(onPublish).toHaveBeenCalledOnce();
    environment.querySelector<HTMLButtonElement>(".chat-pr__diff")!.click();
    expect(onOpenSessionDiff).toHaveBeenCalledOnce();
    element.props = {
      ...element.props!,
      pullRequestsBranch: { ...branch, additions: undefined, deletions: undefined },
    };
    await element.updateComplete;
    expect(environment.querySelector(".chat-pr__diff")).toBeNull();
    expect(environment.querySelector("button.chat-pr__create")?.textContent).toBe("Create PR");
    expect(onOpenSessionDiff).toHaveBeenCalledOnce();
    element.props = {
      ...element.props!,
      pullRequestsBranch: undefined,
      githubPublication: undefined,
      pullRequests: [pullRequest()],
    };
    await element.updateComplete;
    await waitForSolid(() =>
      expect(
        element.querySelector('[data-details-group="pull-requests"] .chat-pr__link'),
      ).not.toBeNull(),
    );
    expect(environment.querySelector(".chat-pr__publication-actions")).toBeNull();
  },
);

it("keeps local Changes after publication and accepts a confirmed clean working tree", async () => {
  const branch = sessionBranch({ branch: "feature/published", additions: 7, deletions: 2 });
  const element = await mount({
    detailsWorkspace: { root: "/synthetic/project", label: "project", branch: branch.branch },
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
  const environment = element.querySelector('[data-details-group="environment"]')!;
  await waitForSolid(() =>
    expect(environment.querySelector(".chat-pr__diff")?.textContent).toContain("+7"),
  );
  expect(environment.textContent).toContain(branch.branch);
  expect(environment.querySelector(".chat-pr__publication-actions")).toBeNull();
  expect(environment.querySelector(".chat-pr__diff")?.textContent).toContain("+7");
  expect(environment.querySelector(".chat-pr__diff")?.textContent).toContain("−2");
  element.props = {
    ...element.props!,
    environment: {
      uncommitted: { sessionKey: "agent:main:details", files: [], additions: 0, deletions: 0 },
    },
  };
  await element.updateComplete;
  expect(environment.querySelector(".chat-pr__diff")).toBeNull();
  expect(environment.textContent).toContain(branch.branch);
  await waitForSolid(() =>
    expect(
      element.querySelector('[data-details-group="pull-requests"] a[href$="/pull/44"]'),
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
    detailsWorkspace: { root: "/synthetic/project", label: "project", branch: "feature/current" },
    pullRequests: [pullRequest({ branch: "feature/current" })],
    githubPublication: failed,
  });
  const environment = element.querySelector('[data-details-group="environment"]')!;
  expect(environment.querySelector(".chat-pr__publication-actions")).toBeNull();
  element.props = {
    ...element.props!,
    githubPublication: publication({
      locked: true,
    }),
  };
  await element.updateComplete;
  await waitForSolid(() =>
    expect(environment.querySelector(".chat-pr__create")?.textContent).toBe("Check publication"),
  );
  element.props = {
    ...element.props!,
    githubPublication: failed,
    pullRequestsBranch: sessionBranch({ branch: "feature/next", additions: 3 }),
  };
  await element.updateComplete;
  await waitForSolid(() =>
    expect(environment.querySelector(".chat-pr__create")?.textContent).toBe("Retry"),
  );
  expect(environment.querySelector(".chat-pr__diff")?.textContent).toContain("+3");
});

it.each([false, true])(
  "shows only textual Changes facts without binary metadata (mobile=%s)",
  async (mobile) => {
    // jsdom has no Web Animations API; arrival motion has separate browser proof.
    const animate = Object.getOwnPropertyDescriptor(Element.prototype, "animate");
    Object.defineProperty(Element.prototype, "animate", {
      configurable: true,
      value: () => ({ cancel() {} }),
    });
    const [uncommitted, setUncommitted] = createSignal<SessionsDiffResult>();
    const open = vi.fn();
    const details: ChatDetailsProps = {
      sessionKey: "agent:main:details",
      currentAgentId: "main",
      messages: [],
      selectedSession: undefined,
    };
    const view = mountSolid(() =>
      createComponent(mobile ? ChatDetailsEnvironmentMobile : ChatDetailsEnvironment, {
        details,
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
      sessionKey: details.sessionKey,
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
        view.container.querySelector("[data-details-group=environment], .chat-environment-mobile"),
      ).toBeNull();
    }
    for (const data of [
      { ...result, additions: 3, files: [{ ...text, deletions: 0 }] },
      { ...result, deletions: 1, files: [{ ...text, additions: 0 }] },
      { ...result, additions: 3, deletions: 1, files: [text, binary], truncated: true },
    ]) {
      setUncommitted(data);
      flush();
      await waitForSolid(() => expect(row()).toBeDefined());
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
      details: {
        sessionKey: result.sessionKey,
        currentAgentId: "main",
        messages: [],
        selectedSession: undefined,
      },
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
  expect(view.container.querySelector('[data-details-group="environment"]')).toBeNull();
  setUncommitted(result);
  await waitForSolid(() => expect(stop).toHaveBeenCalledOnce());
  expect(view.container.querySelector('[data-details-group="environment"]')).not.toBeNull();
});
