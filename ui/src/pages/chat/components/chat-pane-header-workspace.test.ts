/* @vitest-environment jsdom */
import { expect, it, onTestFinished } from "vitest";
import type { GatewaySessionRow } from "../../../api/types.ts";
import { resolveSessionWorkspace } from "../../../lib/sessions/workspace.ts";
import {
  resolveChatPaneWorkspace,
  resolveChatPaneParentSession,
} from "../chat-pane-header-identity.ts";
import {
  chatPaneHeaderSessionRow as row,
  mountChatPaneHeader,
} from "./chat-pane-header.test-support.ts";

it("omits unresolved and self-referential parents", () => {
  const child = row({ key: "agent:main:child", parentSessionKey: "agent:main:missing" });
  expect(resolveChatPaneParentSession(child, [child])).toBeNull();
  expect(
    resolveChatPaneParentSession({ ...child, parentSessionKey: child.key }, [child]),
  ).toBeNull();
});

const repo = "/src/openclaw";
const checkout = "/tmp/worktrees/title-bar";
const worktree = { id: "wt-1", branch: "title-bar", repoRoot: repo };
const agentWorkspace = "/local/default";
const remote = { execNode: "build-mac", execCwd: "/remote/build" };
const botWorkspace = "/local/workspace/bot-stable-id";
const botSession = row({ key: "agent:bot-stable-id:main" });
function headerWorkspace(overrides: Partial<Parameters<typeof resolveChatPaneWorkspace>[0]>) {
  return resolveChatPaneWorkspace({
    session: row(),
    agentWorkspace,
    worktreePaths: new Map(),
    branches: new Map(),
    methodAdvertised: true,
    hasAdminAccess: true,
    ...overrides,
  });
}
type WorkspaceCase = [
  Partial<GatewaySessionRow>,
  string | null,
  string | null,
  Omit<Parameters<typeof resolveSessionWorkspace>[0], "session">?,
];
it.each<WorkspaceCase>([
  [{ spawnedCwd: checkout, worktree }, checkout, "openclaw"],
  [{ worktree }, null, "openclaw", { agentWorkspace, worktreePath: null }],
  [{ spawnedWorkspaceDir: repo, spawnedCwd: `${repo}/packages/nested` }, repo, "openclaw"],
  [{ execCwd: "/remote/stale", spawnedCwd: repo }, repo, "openclaw"],
  [remote, remote.execCwd, "build", { agentWorkspace }],
  [
    { execNode: "build-mac", spawnedCwd: "/local/spawned" },
    null,
    null,
    { agentWorkspace, worktreePath: "/local/worktree" },
  ],
  [{}, repo, "openclaw", { agentWorkspace: repo }],
  [botSession, botWorkspace, "Workspace", { agentWorkspace: botWorkspace }],
])("resolves workspace from %j", (session, root, label, options) => {
  expect(resolveSessionWorkspace({ session: row(session), ...options })).toEqual({ root, label });
});

it("keeps the workspace breadcrumb free of a tooltip", () => {
  const workspaceLabel = "Workspace";
  const containers: HTMLElement[] = [];
  const { container } = mountChatPaneHeader(containers, {
    session: botSession,
    workspaceRoot: botWorkspace,
    workspaceLabel,
  });
  onTestFinished(() => containers.forEach((mounted) => mounted.remove()));
  const crumb = container.querySelector<HTMLElement>(".chat-pane__workspace-chip");
  expect(crumb?.textContent).toContain(workspaceLabel);
  expect(crumb?.getAttribute("aria-label")).toContain(workspaceLabel);
  expect(crumb?.hasAttribute("title")).toBe(false);
});

it.each<Partial<Parameters<typeof resolveChatPaneWorkspace>[0]>>([
  {
    session: row(remote),
  },
  {
    session: row({ placement: { state: "requested" } as GatewaySessionRow["placement"] }),
  },
  { methodAdvertised: false },
  { hasAdminAccess: false },
])("disables reveal for unavailable or unauthorized workspaces: %j", (overrides) => {
  expect(headerWorkspace({ agentWorkspace: repo, ...overrides }).canReveal).toBe(false);
});

it("omits the default agent workspace from header identity", () => {
  const workspace = headerWorkspace({});
  expect(workspace).toEqual({ root: agentWorkspace, label: null, branch: null, canReveal: true });
});

it("preserves a real project even when it uses the agent workspace directory", () => {
  const workspace = headerWorkspace({
    session: row({
      spawnedCwd: agentWorkspace,
      worktree: { id: "project", repoRoot: agentWorkspace, branch: "feature" },
    }),
  });
  expect(workspace.label).toBe("default");
});
