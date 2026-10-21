/* @vitest-environment jsdom */
import { expect, it } from "vitest";
import type { GatewaySessionRow } from "../../../api/types.ts";
import { resolveSessionWorkspace } from "../../../lib/sessions/workspace.ts";
import {
  canRevealSessionWorkspace,
  resolveChatPaneParentSession,
} from "./chat-pane-header-identity.tsx";
import { chatPaneHeaderSessionRow as row } from "./chat-pane-header.test-support.ts";

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
])("resolves workspace from %j", (session, expected, options) => {
  expect(resolveSessionWorkspace({ session: row(session), ...options })).toEqual(expected);
});

it.each<Partial<Parameters<typeof canRevealSessionWorkspace>[0]>>([
  {
    session: row({ execNode: "build-mac", execCwd: "/remote/build" }),
    workspaceRoot: "/remote/build",
  },
  {
    session: row({ placement: { state: "requested" } as GatewaySessionRow["placement"] }),
    workspaceRoot: "/cloud/work",
  },
  { methodAdvertised: false },
  { hasAdminAccess: false },
])("disables reveal for unavailable or unauthorized workspaces: %j", (overrides) => {
  expect(
    canRevealSessionWorkspace({
      session: row(),
      workspaceRoot: repo,
      methodAdvertised: true,
      hasAdminAccess: true,
      ...overrides,
    }),
  ).toBe(false);
});
