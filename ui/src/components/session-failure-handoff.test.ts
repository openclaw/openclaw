import { createComponent } from "solid-js";
import { expect, it } from "vitest";
import type { GatewaySessionRow } from "../api/types.ts";
import { sessionRowAttention } from "../lib/session-attention.ts";
import {
  resolveSpawnedSubagent,
  spawnedSubagentsRenderKey,
} from "../pages/chat/chat-spawned-subagent.ts";
import { projectProgressCardRuntime } from "../pages/chat/chat-subagent-wait.ts";
import { mountSolid } from "../test-helpers/mount-solid.ts";
import { projectSidebarSession } from "./app-sidebar-session-navigation.test-support.ts";
import { projectSessionTree } from "./app-sidebar-session-tree.ts";
import { ProgressRuntime } from "./session-progress-card-content.tsx";
import { restoreSnapshotSession, snapshotSessions } from "./sidebar-snapshot-model.ts";
import { summarizeTeamSessionSlots, TeamSessionSlots } from "./solid/session-presentation.tsx";

it("keeps inherited diagnostics without red attention across tree, team and saved snapshot", () => {
  const parent: GatewaySessionRow = {
    key: "agent:main:parent",
    kind: "direct",
    sessionId: "parent",
    updatedAt: 1,
    childSessions: ["agent:main:subagent:child"],
  };
  const child: GatewaySessionRow = {
    key: "agent:main:subagent:child",
    kind: "direct",
    sessionId: "child",
    updatedAt: 2,
    status: "failed",
    lastRunError: "Synthetic provider cause",
    failureHandedOff: true,
    hasActiveSubagentRun: true,
    spawnedBy: parent.key,
  };
  child.endedAt = 2;
  const runtime = projectProgressCardRuntime(
    parent,
    { subagentParentKey: parent.key, subagentSessions: [child], subagentSessionsHydrated: true },
    1,
  );
  expect(runtime.children).toMatchObject({ failed: 1, attentionFailed: 0, waiting: 0 });
  expect(runtime.childError).toBeUndefined();
  const launch = {
    name: "sessions_spawn",
    args: { label: "Child" },
    details: { childSessionKey: child.key },
  };
  expect(resolveSpawnedSubagent(launch, [child])?.session).toMatchObject({
    ended: "failed",
    failureHandedOff: true,
  });
  expect(spawnedSubagentsRenderKey([child])).not.toBe(
    spawnedSubagentsRenderKey([{ ...child, failureHandedOff: false }]),
  );
  const rows = new Map([parent, child].map((row) => [row.key, row]));
  const tree = () =>
    projectSessionTree({
      roots: [parent],
      rowsByKey: rows,
      loadingChildKeys: new Set(),
      resolveAttention: (row) => sessionRowAttention(rows.get(row.key)!),
      toSidebarSession: (row, isChild) => ({
        ...projectSidebarSession(row),
        isChild: isChild ?? false,
        failureHandedOff: row.failureHandedOff,
        attention: sessionRowAttention(row),
      }),
    });
  const [owned] = tree();
  expect(owned).toMatchObject({
    failedChildCount: 1,
    attentionFailedChildCount: 0,
    attention: { kind: "none" },
  });
  expect(summarizeTeamSessionSlots([owned!], true).failed).toBe(false);
  const restored = restoreSnapshotSession(snapshotSessions([owned!])[0]!, "");
  expect(restored).toMatchObject({
    failedChildCount: 1,
    attentionFailedChildCount: 0,
    attention: { kind: "none" },
  });
  expect(summarizeTeamSessionSlots([restored], true).failed).toBe(false);
  rows.set(child.key, { ...child, failureHandedOff: false });
  expect(tree()[0]).toMatchObject({
    failedChildCount: 1,
    attentionFailedChildCount: 1,
    attention: { kind: "error" },
  });
  expect(
    sessionRowAttention({ ...parent, status: "failed", lastRunError: "Parent's own error" }),
  ).toMatchObject({ kind: "error", reason: "Parent's own error" });
  expect(
    sessionRowAttention(
      {
        ...child,
        agentStatus: { note: "Choose a target", attention: "hand", expiresAt: 100 },
      },
      2,
    ),
  ).toMatchObject({ kind: "agent", note: "Choose a target" });
});

it.each([false, true])(
  "renders diagnostics without inherited red when handed off=%s",
  (handedOff) => {
    const parent: GatewaySessionRow = { key: "agent:main:parent", kind: "direct", updatedAt: 1 };
    const failed: GatewaySessionRow = {
      key: "agent:main:subagent:failed",
      kind: "direct",
      updatedAt: 2,
      spawnedBy: parent.key,
      status: "failed",
      endedAt: 2,
      failureHandedOff: handedOff,
      hasActiveSubagentRun: handedOff,
      lastRunError: "Child provider unavailable",
    };
    const waiting: GatewaySessionRow = {
      key: "agent:main:subagent:waiting",
      kind: "direct",
      updatedAt: 2,
      spawnedBy: parent.key,
      status: "done",
      endedAt: 2,
      hasActiveSubagentRun: true,
    };
    const runtime = projectProgressCardRuntime(
      parent,
      {
        subagentParentKey: parent.key,
        subagentSessions: [failed, waiting],
        subagentSessionsHydrated: true,
      },
      1,
      true,
    );
    expect(runtime.children).toMatchObject({
      failed: 1,
      waiting: 1,
      attentionFailed: handedOff ? 0 : 1,
    });
    const progress = mountSolid(() =>
      createComponent(ProgressRuntime, { runtime, sessionStatus: "done" }),
    );
    expect(progress.container.querySelector("[data-error]")?.getAttribute("data-error")).toBe(
      String(!handedOff),
    );
    expect(progress.container.textContent).toContain("1 failed");
    expect(progress.container.textContent).toContain("1 waiting");
    expect(progress.container.textContent?.includes("Child provider unavailable")).toBe(!handedOff);
    const row = {
      ...projectSidebarSession({ key: "agent:main:parent" }),
      failedChildCount: 1,
      attentionFailedChildCount: handedOff ? 0 : 1,
    };
    const team = mountSolid(() =>
      createComponent(TeamSessionSlots, { rows: [row], includeChildren: true, childCount: 1 }),
    );
    expect(team.container.querySelectorAll(".sidebar-child-session__status--failed")).toHaveLength(
      handedOff ? 0 : 1,
    );
  },
);
