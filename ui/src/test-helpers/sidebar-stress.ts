import { vi } from "vitest";
import { SESSION_PLACEMENT_STATES } from "../../../packages/gateway-protocol/src/schema/session-placement-state.ts";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import type { GatewaySessionRow } from "../api/types.ts";
import { createGatewayHarness, createSessionsHarness, mountSidebar } from "./app-sidebar.ts";
import "../components/app-sidebar.ts";
export const owner = {
  type: "human",
  id: "nora",
  label: "Nora",
  identity: { type: "profile", id: "nora" },
} as const;
export const other = {
  type: "human",
  id: "casey",
  label: "Casey",
  identity: { type: "profile", id: "casey" },
} as const;
const participant = { identity: { type: "profile", id: "casey" }, label: "Casey" } as const;
export const key = (id: string) => "agent:main:stress-" + id;
function placement(
  state: (typeof SESSION_PLACEMENT_STATES)[number],
): NonNullable<GatewaySessionRow["placement"]> {
  const timing = { generation: 1, createdAtMs: 1, updatedAtMs: 1, stateChangedAtMs: 1 };
  const worker = { environmentId: "fixture", workerBundleHash: "a".repeat(64) };
  const workspace = { workspaceBaseManifestRef: "fixture", remoteWorkspaceDir: "/workspace" };
  switch (state) {
    case "local":
      return { ...timing, state };
    case "requested":
      return { ...timing, state };
    case "provisioning":
      return { ...timing, state };
    case "reclaimed":
      return { ...timing, state };
    case "syncing":
      return { ...timing, ...worker, state };
    case "starting":
      return { ...timing, ...worker, ...workspace, state };
    case "active":
      return { ...timing, ...worker, ...workspace, activeOwnerEpoch: 1, state };
    case "draining":
      return { ...timing, ...worker, ...workspace, activeOwnerEpoch: 1, state };
    case "reconciling":
      return { ...timing, ...worker, ...workspace, activeOwnerEpoch: 1, state };
    case "failed":
      return { ...timing, state, recoveryError: "Synthetic placement failure" };
    default:
      throw new Error("Unhandled placement state in sidebar fixture");
  }
}

function fixtures(): GatewaySessionRow[] {
  const rows: GatewaySessionRow[] = [];
  const add = (id: string, patch: Partial<GatewaySessionRow> = {}) =>
    rows.push({
      key: key(id),
      sessionId: id,
      kind: "direct",
      label: id,
      updatedAt: 100,
      createdAt: 100,
      owner: { actor: owner },
      ...patch,
    });
  add("owner-idle");
  add("owner-running", { hasActiveRun: true, status: "running" });
  add("group-running", {
    hasActiveRun: true,
    status: "running",
    participants: [participant],
    participantCount: 1,
  });
  add("group-overflow", {
    hasActiveRun: true,
    status: "running",
    participants: [participant],
    participantCount: 3,
  });
  add("group-large-count", { participants: [participant], participantCount: 99 });
  add("queued", { hasActiveRun: true, status: "queued" });
  add("icon", { hasActiveRun: true, status: "running", icon: "braces" });
  add("emoji", { hasActiveRun: true, status: "running", icon: "🦞" });
  add("unread", { unread: true });
  add("unread-running", { unread: true, hasActiveRun: true, status: "running" });
  add("no-owner", { owner: undefined, hasActiveRun: true, status: "running" });
  add("other-owner", { owner: { actor: other } });
  for (const status of ["done", "failed", "killed", "timeout"] as const) {
    add(status, {
      status,
      ...(status === "failed" ? { lastRunError: "Synthetic render failure" } : {}),
    });
  }
  add("agent-attention", {
    agentStatus: { note: "Needs a decision", attention: "key", expiresAt: Date.now() + 600000 },
  });
  add("agent-note", {
    hasActiveRun: true,
    status: "running",
    agentStatus: { note: "Checking the patch", expiresAt: Date.now() + 600000 },
  });
  add("channel-fallback", {
    channelAvatarUrl: "/__openclaw__/channel-avatar/stress-missing",
    hasActiveRun: true,
    status: "running",
  });
  add("private", { incognito: true });
  add("approval", { hasActiveRun: true, status: "running" });
  add("archived", { archived: true, archivedBy: other });
  for (const state of ["open", "draft", "merged", "closed"] as const) {
    add("pr-" + state);
  }
  add("crowded", {
    incognito: true,
    hasActiveRun: true,
    status: "running",
    participants: [participant],
    participantCount: 3,
    worktree: { id: "crowded", repoRoot: "/projects/alpha", branch: "feature/crowded" },
    placement: {
      state: "active",
      generation: 1,
      createdAtMs: 1,
      updatedAtMs: 1,
      stateChangedAtMs: 1,
      environmentId: "fixture",
      activeOwnerEpoch: 1,
      workerBundleHash: "a".repeat(64),
      workspaceBaseManifestRef: "fixture",
      remoteWorkspaceDir: "/workspace",
      diskSpace: { status: "critical", availableBytes: 1, totalBytes: 100, observedAtMs: 1 },
      workspaceResultConflict: { paths: ["conflict.txt"], stagedResultRef: "fixture" },
    },
  });
  add("unsent-draft");
  add("outbox");
  add("ghost-draft", { visibility: "draft" });
  add("fork", { forkSource: { sessionKey: key("owner-idle"), sessionId: "original" } });
  add("pinned", {
    pinned: true,
    hasActiveRun: true,
    status: "running",
    participants: [participant],
    participantCount: 1,
  });
  add("custom", { category: "Custom review", hasActiveRun: true, status: "running" });
  add("conversation", { kind: "group", channel: "discord" });
  add("project-a", {
    worktree: { id: "a", repoRoot: "/projects/alpha", branch: "feature/a" },
    hasActiveRun: true,
    status: "running",
  });
  add("project-b", { worktree: { id: "b", repoRoot: "/projects/beta", branch: "feature/b" } });
  add("same-project-name", {
    worktree: { id: "c", repoRoot: "/other/alpha", branch: "feature/c" },
  });
  add("node", { execNode: "test-node", execCwd: "/projects/remote" });
  add("very long title that must truncate without colliding with controls or identities", {
    color: "purple",
    participants: [participant],
    participantCount: 3,
  });
  add("question", { hasActiveRun: true, status: "running" });
  for (const state of SESSION_PLACEMENT_STATES) {
    add("placement-" + state, { placement: placement(state) });
  }
  const children = ["queued", "running", "done", "failed", "killed", "timeout"].map((status) =>
    key("child-" + status),
  );
  add("parent", { childSessions: children });
  for (const status of ["queued", "running", "done", "failed", "killed", "timeout"] as const) {
    add("child-" + status, {
      spawnedBy: key("parent"),
      status,
      hasActiveRun: status === "queued" || status === "running",
      startedAt: 1,
      endedAt: status === "running" ? undefined : 100,
      runtimeMs: 1000,
    });
  }
  rows.push({
    key: "agent:main:main",
    kind: "direct",
    label: "Home",
    updatedAt: 1,
    hasActiveRun: true,
    status: "running",
  });
  return rows;
}
export async function settled(sidebar: Awaited<ReturnType<typeof mountSidebar>>["sidebar"]) {
  await sidebar.updateComplete;
  await vi.dynamicImportSettled();
  await sidebar.updateComplete;
  await Promise.all(
    [...sidebar.querySelectorAll("openclaw-session-owner-chip")].map((x) => x.updateComplete),
  );
  await Promise.all(
    [...sidebar.querySelectorAll("openclaw-viewer-avatar")].map((x) => x.updateComplete),
  );
  await new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });
}
export async function mount(width: number) {
  const rows = fixtures();
  const harness = createSessionsHarness("main", []);
  const result = harness.sessions.state.result;
  if (!result) {
    throw new Error("Missing harness result");
  }
  result.sessions = rows;
  result.count = rows.length;
  result.owners = [owner, other];
  harness.publish({ groups: ["Custom review", "Empty category"] });
  // SAFETY: the production sidebar harness owns this synthetic RPC client; no real Gateway is used.
  const gateway = createGatewayHarness({
    instanceId: "self",
    request: vi.fn(async (method: string) =>
      method === "sessions.list"
        ? result
        : method === "sessions.catalogs.list"
          ? { catalogs: [] }
          : method === "questions.list"
            ? { questions: [] }
            : {},
    ),
  } as unknown as GatewayBrowserClient);
  for (const state of ["open", "draft", "merged", "closed"] as const) {
    harness.sessions.setPullRequestSummary(key("pr-" + state), { numbers: [123, 456], state });
  }
  harness.sessions.setPullRequestSummary(key("crowded"), { numbers: [123], state: "open" });
  const approvals = ["approval", "crowded"].map((id) => ({
    id: "stress-approval-" + id,
    kind: "exec" as const,
    request: { command: "echo fixture", sessionKey: key(id) },
    createdAtMs: Date.now(),
    expiresAtMs: Date.now() + 600000,
  }));
  const mounted = await mountSidebar(gateway.gateway, harness.sessions, "panel", null, approvals);
  const { sidebar } = mounted;
  sidebar.style.cssText = `display:block;width:${width}px;height:1000px`;
  sidebar.connected = true;
  sidebar.hasSessionDraft = (k) => k === key("unsent-draft") || k === key("crowded");
  sidebar.outboxAttentionCountForSession = (k) =>
    k === key("outbox") || k === key("crowded") ? 9 : 0;
  gateway.publishEvent("question.requested", {
    id: "stress-question",
    agentId: "main",
    sessionKey: key("question"),
    questions: [
      {
        questionId: "confirm",
        header: "Confirm",
        question: "Continue?",
        options: [{ label: "Continue" }],
      },
    ],
    createdAtMs: Date.now(),
    expiresAtMs: Date.now() + 600000,
    status: "pending",
  });
  await settled(sidebar);
  return {
    ...mounted,
    harness,
    gateway,
    fixtureKeys: rows
      .filter((row) => !row.archived && row.key !== "agent:main:main")
      .map((row) => row.key),
  };
}
export function geometry(sidebar: HTMLElement) {
  return [...sidebar.querySelectorAll<HTMLElement>(".sidebar-recent-session")]
    .map((row) => {
      const rect = row.getBoundingClientRect(),
        title = row.querySelector<HTMLElement>(".sidebar-recent-session__name"),
        lead = row.querySelector<HTMLElement>(".sidebar-session-indicator");
      return {
        key: row.dataset.sessionKey ?? "",
        rect,
        title: title?.getBoundingClientRect(),
        lead: lead?.getBoundingClientRect(),
        rings: [...row.querySelectorAll<HTMLElement>(".session-glyph__ring")].map((r) => {
          const box = r.getBoundingClientRect();
          const diameter = Number.parseFloat(getComputedStyle(r).width);
          // Rotation expands a square bounding box, not the visible circular ring.
          // Measure the circle around that unchanged center at every animation phase.
          return {
            rect: new DOMRect(
              box.x + (box.width - diameter) / 2,
              box.y + (box.height - diameter) / 2,
              diameter,
              diameter,
            ),
            bare: r.parentElement?.classList.contains("session-glyph--bare"),
          };
        }),
        stacks: [...row.querySelectorAll<HTMLElement>(".session-owner-stack")].map((s) =>
          s.getBoundingClientRect(),
        ),
      };
    })
    .filter((row) => row.rect.height > 0);
}
