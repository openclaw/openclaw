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
type WorkspaceCase = [
  Partial<GatewaySessionRow>,
  ReturnType<typeof resolveSessionWorkspace>,
  Omit<Parameters<typeof resolveSessionWorkspace>[0], "session">?,
];
it.each<WorkspaceCase>([
  [
    { spawnedCwd: checkout, worktree },
    { root: checkout, label: "openclaw" },
  ],
  [{ worktree }, { root: null, label: "openclaw" }, { agentWorkspace, worktreePath: null }],
  [
    { spawnedWorkspaceDir: repo, spawnedCwd: `${repo}/packages/nested` },
    { root: repo, label: "openclaw" },
  ],
  [
    { execCwd: "/remote/stale", spawnedCwd: repo },
    { root: repo, label: "openclaw" },
  ],
  [
    { execNode: "build-mac", execCwd: "/remote/build" },
    { root: "/remote/build", label: "build" },
    { agentWorkspace },
  ],
  [
    { execNode: "build-mac", spawnedCwd: "/local/spawned" },
    { root: null, label: null },
    { agentWorkspace, worktreePath: "/local/worktree" },
  ],
  [{}, { root: repo, label: "openclaw" }, { agentWorkspace: repo }],
  [
    { key: "agent:bot-stable-id:main" },
    { root: "/local/workspace/bot-stable-id", label: "Workspace" },
    { agentWorkspace: "/local/workspace/bot-stable-id" },
  ],
])("resolves workspace from %j", (session, expected, options) => {
  expect(resolveSessionWorkspace({ session: row(session), ...options })).toEqual(expected);
});

it("does not expose a new agent's storage ID in the workspace breadcrumb tooltip", () => {
  const containers: HTMLElement[] = [];
  const { container } = mountChatPaneHeader(containers, {
    session: row({ key: "agent:bot-stable-id:main" }),
    workspaceRoot: "/local/workspace/bot-stable-id",
    workspaceLabel: "Workspace",
  });
  onTestFinished(() => containers.forEach((mounted) => mounted.remove()));
  const crumb = container.querySelector<HTMLElement>(".chat-pane__workspace-chip");
  expect(crumb?.textContent).toContain("Workspace");
  expect(crumb?.getAttribute("title")).toBe("Workspace");
});

it.each<Partial<Parameters<typeof resolveChatPaneWorkspace>[0]>>([
  {
    session: row({ execNode: "build-mac", execCwd: "/remote/build" }),
  },
  {
    session: row({ placement: { state: "requested" } as GatewaySessionRow["placement"] }),
  },
  { methodAdvertised: false },
  { hasAdminAccess: false },
])("disables reveal for unavailable or unauthorized workspaces: %j", (overrides) => {
  expect(
    resolveChatPaneWorkspace({
      session: row(),
      agentWorkspace: repo,
      worktreePaths: new Map(),
      branches: new Map(),
      methodAdvertised: true,
      hasAdminAccess: true,
      ...overrides,
    }).canReveal,
  ).toBe(false);
});
