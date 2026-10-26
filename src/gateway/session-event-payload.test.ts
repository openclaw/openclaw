import { expect, it } from "vitest";
import { contextBudgetStatusFixture } from "../config/sessions/context-budget.test-support.js";
import { buildGatewaySessionSnapshot } from "./session-event-payload.js";
import { createSessionGoalFixture } from "./session-goal.test-support.js";

type SnapshotParams = Parameters<typeof buildGatewaySessionSnapshot>[0];
type SessionRow = NonNullable<SnapshotParams["sessionRow"]>;
const row = { key: "agent:main:main", kind: "direct" as const, updatedAt: 1 };
function snapshot(
  sessionRow: Partial<SessionRow> = {},
  options: Omit<SnapshotParams, "sessionRow"> = {},
) {
  return buildGatewaySessionSnapshot({ sessionRow: { ...row, ...sessionRow }, ...options });
}
function expectBoth(value: unknown, fields: Record<string, unknown>) {
  expect(value).toMatchObject({ ...fields, session: fields });
}
function wire(value: unknown): unknown {
  // oxlint-disable-next-line unicorn/prefer-structured-clone -- verify the gateway JSON wire shape
  return JSON.parse(JSON.stringify(value));
}

it.each([
  ["titlePending", true, false],
  ["lastAssistantMessage", { text: "Previous answer", timestamp: 100 }, null],
  ["autoLabel", "Device", null],
  ["displayName", "Device", null],
  ["contextBudgetStatus", contextBudgetStatusFixture(), null],
  ["deviceFolder", { deviceId: "paired-device", path: "/home/example/project" }, null],
] as const)("publishes and clears %s in subscribed snapshots", (field, value, cleared) => {
  const previous = snapshot({ [field]: value });
  expect(previous).toHaveProperty(field, value);
  expect(previous).toHaveProperty(`session.${field}`, value);
  const expected = { [field]: cleared };
  const current = { ...previous, ...snapshot() };
  expect(current).toMatchObject({ ...expected, session: expected });
});

it("projects the prepared permission boundary only for an explicit mode", () => {
  const ordinary = snapshot({ sessionRoot: "/workspace/private", updatedAt: 3 });
  expect(ordinary).toMatchObject({ permissionMode: null });
  expect(ordinary).not.toHaveProperty("sessionRoot");
  expect(
    snapshot({ permissionMode: "workspace", sessionRoot: "/workspace/project", updatedAt: 4 }),
  ).toMatchObject({ permissionMode: "workspace", sessionRoot: "/workspace/project" });
});

it("serializes merge tombstones without flattening row-only execution fields", () => {
  const serialized = wire(
    snapshot({
      updatedAt: 5,
      traceLevel: "full",
      worktree: { id: "wt-1", branch: "feature", repoRoot: "/private/repo" },
      execNode: "private-node",
      execCwd: "/private/cwd",
    }),
  );
  const tombstones = {
    agentStatus: null,
    observerDigest: null,
    activeModel: null,
    activeModelProvider: null,
    traceLevel: "full",
  };
  expect(serialized).toMatchObject({
    ...tombstones,
    session: {
      ...tombstones,
      worktree: { id: "wt-1", branch: "feature", repoRoot: "/private/repo" },
      execNode: "private-node",
      execCwd: "/private/cwd",
    },
  });
  for (const field of ["worktree", "execNode", "execCwd", "placement"]) {
    expect(serialized, field).not.toHaveProperty(field);
  }
});

it("scopes the global goal to its resolved agent", () => {
  const sessionRow = {
    key: "global",
    kind: "global" as const,
    updatedAt: 6,
    goal: createSessionGoalFixture("goal-1", "Scoped objective", { updatedAt: 2, tokensUsed: 3 }),
  };
  const unscoped = buildGatewaySessionSnapshot({ sessionRow });
  expect(unscoped).not.toHaveProperty("goal");
  expect(unscoped).not.toHaveProperty("session.goal");
  expectBoth(buildGatewaySessionSnapshot({ sessionRow, agentId: "main" }), {
    goal: sessionRow.goal,
  });
});

it("preserves active run id ownership across omitted, liveness, and exact states", () => {
  const build = (activeRunState?: { active: boolean; runIds?: string[] }) =>
    wire(snapshot({ kind: "global", updatedAt: 7 }, { activeRunState }));
  const omitted = build();
  for (const field of [
    "hasActiveRun",
    "activeRunIds",
    "session.hasActiveRun",
    "session.activeRunIds",
  ]) {
    expect(omitted).not.toHaveProperty(field);
  }
  expectBoth(build({ active: true }), { hasActiveRun: true, activeRunIds: null });
  expectBoth(build({ active: false, runIds: [] }), { hasActiveRun: false, activeRunIds: [] });
  expectBoth(build({ active: true, runIds: ["run-1"] }), {
    hasActiveRun: true,
    activeRunIds: ["run-1"],
  });
});

it.each([false, true])(
  "serializes lifecycle starts without prior timing, deriving liveness from the owner (active=%s)",
  (active) => {
    const serialized = wire(
      snapshot(
        {
          key: "agent:main:pinned",
          sessionId: "pinned-session",
          updatedAt: 200,
          status: "done",
          startedAt: 100,
          endedAt: 200,
          runtimeMs: 100,
          model: "model-a",
          modelProvider: "provider",
          activeModel: "model-b",
          activeModelProvider: "fallback-provider",
          modelOverrideSource: "user",
        },
        {
          lifecycle: true,
          activeRunState: active ? { active: true, runIds: ["next-run"] } : undefined,
          event: {
            runId: "next-run",
            sessionId: "pinned-session",
            seq: 1,
            ts: 300,
            stream: "lifecycle",
            data: { phase: "start", startedAt: 300 },
          },
        },
      ),
    );
    expectBoth(serialized, {
      ...(active ? { status: "running" } : {}),
      startedAt: 300,
      endedAt: null,
      runtimeMs: null,
    });
    if (!active) {
      expect(serialized).not.toHaveProperty("status");
      expect(serialized).not.toHaveProperty("session.status");
    }
    for (const field of [
      "model",
      "modelProvider",
      "activeModel",
      "activeModelProvider",
      "modelOverrideSource",
      "agentRuntime",
    ]) {
      expect(serialized).not.toHaveProperty(field);
      expect(serialized).not.toHaveProperty(`session.${field}`);
    }
  },
);

it.each([
  { aborted: false, status: "done" },
  { aborted: true, status: "killed" },
])("keeps terminal $status ahead of retained active cleanup", ({ aborted, status }) => {
  expectBoth(
    snapshot(
      {
        key: "agent:main:terminal",
        sessionId: "terminal-session",
        createdAt: 50,
        lastReadAt: 150,
        lastActivityAt: 120,
        unread: false,
        updatedAt: 100,
        startedAt: 100,
      },
      {
        lifecycle: true,
        lifecycleRunId: "terminal-run",
        activeRunState: { active: true, status: "queued" },
        event: {
          runId: "terminal-run",
          sessionId: "terminal-session",
          seq: 1,
          ts: 200,
          stream: "lifecycle",
          controlUiVisible: true,
          data: { phase: "end", startedAt: 100, endedAt: 200, aborted },
        },
      },
    ),
    { status, unread: true, lastActivityAt: 200, hasActiveRun: true, endedAt: 200, runtimeMs: 100 },
  );
});
