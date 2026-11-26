import { describe, expect, it, vi } from "vitest";
import type { GatewaySessionRow } from "../../api/types.ts";
import type { GitHubPublicationBinding } from "../../lib/sessions/session-types.ts";
import { createApplicationGatewaySnapshot } from "../../test-helpers/application-context-fixtures.ts";
import { synchronizeChatPanePublication } from "./chat-pane-publication.ts";

// A session-scoped member: publication options are a session read, not operator.read.
const gatewaySnapshot = createApplicationGatewaySnapshot({
  phase: "connected",
  client: {} as never,
  hello: {
    auth: { role: "operator", scopes: ["operator.sessions.read", "operator.sessions.write"] },
    features: { methods: ["sessions.github.publish", "sessions.github.options"] },
  } as never,
});

function synchronize(row: GatewaySessionRow) {
  const sync = vi.fn();
  const attach = vi.fn(
    () => ({ matches: () => true, detach: vi.fn(), sync }) as unknown as GitHubPublicationBinding,
  );
  synchronizeChatPanePublication({
    holder: { binding: null },
    publications: { attach },
    gatewaySnapshot,
    readRow: () => row,
    isScopeCurrent: () => true,
    isPresented: () => true,
    participationBlocked: false,
    runActive: false,
    workspaceConflict: false,
  });
  return { attach, sync };
}

describe("chat pane publication", () => {
  const row = {
    key: "agent:main:main",
    kind: "direct",
    updatedAt: 1,
    worktree: { id: "garden-workspace", branch: "openclaw/garden", repoRoot: "/synthetic/garden" },
  } as GatewaySessionRow;

  it.each(["removed-snapshot", "removed-fresh"] as const)(
    "does not read publication options while the workspace is %s",
    (worktreeState) => {
      const { attach } = synchronize({ ...row, worktreeState });
      expect(attach).not.toHaveBeenCalled();
    },
  );

  it("reads publication options once the workspace is restored", () => {
    const { attach, sync } = synchronize({ ...row, worktreeState: "ready" });
    expect(attach).toHaveBeenCalledOnce();
    expect(sync).toHaveBeenCalledOnce();
  });
});
