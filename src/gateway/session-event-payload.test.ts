import { expect, it } from "vitest";
import { contextBudgetStatusFixture } from "../config/sessions/context-budget.test-support.js";
import { buildGatewaySessionSnapshot } from "./session-event-payload.js";

it("clears transient title pending in both event and nested session snapshots", () => {
  const sessionRow = { key: "agent:main:dashboard:title", kind: "direct" as const, updatedAt: 1 };
  expect(
    buildGatewaySessionSnapshot({
      sessionRow: { ...sessionRow, titlePending: true },
      includeSession: true,
    }),
  ).toMatchObject({ titlePending: true, session: { titlePending: true } });
  expect(buildGatewaySessionSnapshot({ sessionRow, includeSession: true })).toMatchObject({
    titlePending: false,
    session: { titlePending: false },
  });
});

it("clears assistant previews in event and nested session snapshots", () => {
  const sessionRow = { key: "agent:main:preview", kind: "direct" as const, updatedAt: 1 };
  const previous = buildGatewaySessionSnapshot({
    sessionRow: {
      ...sessionRow,
      lastAssistantMessage: { text: "Previous answer", timestamp: 100 },
    },
    includeSession: true,
  });
  const cleared = buildGatewaySessionSnapshot({ sessionRow, includeSession: true });
  expect({ ...previous, ...cleared }).toMatchObject({
    lastAssistantMessage: null,
    session: { lastAssistantMessage: null },
  });
});

it("clears automatic-label metadata when a subscribed client merges a later snapshot", () => {
  const sessionRow = { key: "agent:main:node-device", kind: "direct" as const, updatedAt: 1 };
  const previous = buildGatewaySessionSnapshot({
    sessionRow: { ...sessionRow, autoLabel: "Device", displayName: "Device" },
  });
  const cleared = buildGatewaySessionSnapshot({ sessionRow });
  expect({ ...previous, ...cleared }).toMatchObject({ autoLabel: null, displayName: null });
});

it("projects the prepared permission boundary only for an explicit mode", () => {
  const ordinary = buildGatewaySessionSnapshot({
    sessionRow: {
      key: "agent:main:ordinary",
      kind: "direct",
      sessionRoot: "/workspace/private",
      updatedAt: 3,
    },
  });
  expect(ordinary).toMatchObject({ permissionMode: null });
  expect(ordinary).not.toHaveProperty("sessionRoot");

  expect(
    buildGatewaySessionSnapshot({
      sessionRow: {
        key: "agent:main:workspace",
        kind: "direct",
        permissionMode: "workspace",
        sessionRoot: "/workspace/project",
        updatedAt: 4,
      },
    }),
  ).toMatchObject({ permissionMode: "workspace", sessionRoot: "/workspace/project" });
});

it("serializes merge tombstones without flattening row-only execution fields", () => {
  // oxlint-disable-next-line unicorn/prefer-structured-clone -- verify the gateway JSON wire shape
  const snapshot = JSON.parse(
    JSON.stringify(
      buildGatewaySessionSnapshot({
        sessionRow: {
          key: "agent:main:project",
          kind: "direct",
          updatedAt: 5,
          traceLevel: "full",
          worktree: { id: "wt-1", branch: "feature", repoRoot: "/private/repo" },
          execNode: "private-node",
          execCwd: "/private/cwd",
        },
        includeSession: true,
      }),
    ),
  ) as Record<string, unknown>;

  expect(snapshot).toMatchObject({
    agentStatus: null,
    observerDigest: null,
    activeModel: null,
    activeModelProvider: null,
    traceLevel: "full",
    session: {
      agentStatus: null,
      observerDigest: null,
      activeModel: null,
      activeModelProvider: null,
      traceLevel: "full",
      worktree: { id: "wt-1", branch: "feature", repoRoot: "/private/repo" },
      execNode: "private-node",
      execCwd: "/private/cwd",
    },
  });
  for (const field of ["worktree", "execNode", "execCwd", "placement"]) {
    expect(snapshot, field).not.toHaveProperty(field);
  }
});

it("scopes the global goal to its resolved agent", () => {
  const sessionRow = {
    key: "global",
    kind: "global" as const,
    updatedAt: 6,
    goal: {
      schemaVersion: 1 as const,
      id: "goal-1",
      objective: "Scoped objective",
      status: "active" as const,
      createdAt: 1,
      updatedAt: 2,
      tokenStart: 0,
      tokensUsed: 3,
      continuationTurns: 0,
    },
  };

  const unscoped = buildGatewaySessionSnapshot({ sessionRow, includeSession: true });
  expect(unscoped).not.toHaveProperty("goal");
  expect(unscoped).not.toHaveProperty("session.goal");

  const scoped = buildGatewaySessionSnapshot({ sessionRow, agentId: "main", includeSession: true });
  expect(scoped).toMatchObject({ goal: sessionRow.goal, session: { goal: sessionRow.goal } });
});

it("preserves active run id ownership across omitted, liveness, and exact states", () => {
  const build = (activeRunState?: { active: boolean; runIds?: string[] }) =>
    // oxlint-disable-next-line unicorn/prefer-structured-clone -- verify the gateway JSON wire shape
    JSON.parse(
      JSON.stringify(
        buildGatewaySessionSnapshot({
          sessionRow: { key: "agent:main:main", kind: "global", updatedAt: 7 },
          includeSession: true,
          activeRunState,
        }),
      ),
    ) as Record<string, unknown>;

  const omitted = build();
  expect(omitted).not.toHaveProperty("hasActiveRun");
  expect(omitted).not.toHaveProperty("activeRunIds");
  expect(omitted).not.toHaveProperty("session.hasActiveRun");
  expect(omitted).not.toHaveProperty("session.activeRunIds");
  expect(build({ active: true })).toMatchObject({
    hasActiveRun: true,
    activeRunIds: null,
    session: { hasActiveRun: true, activeRunIds: null },
  });
  expect(build({ active: false, runIds: [] })).toMatchObject({
    hasActiveRun: false,
    activeRunIds: [],
    session: { hasActiveRun: false, activeRunIds: [] },
  });
  expect(build({ active: true, runIds: ["run-1"] })).toMatchObject({
    hasActiveRun: true,
    activeRunIds: ["run-1"],
    session: { hasActiveRun: true, activeRunIds: ["run-1"] },
  });
});

it.each([false, true])(
  "serializes lifecycle starts without prior timing, deriving liveness from the owner (active=%s)",
  (active) => {
    // oxlint-disable-next-line unicorn/prefer-structured-clone -- exercise timing clears on the wire
    const snapshot: unknown = JSON.parse(
      JSON.stringify(
        buildGatewaySessionSnapshot({
          sessionRow: {
            key: "agent:main:pinned",
            sessionId: "pinned-session",
            kind: "direct",
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
          lifecycle: true,
          includeSession: true,
          activeRunState: active ? { active: true, runIds: ["next-run"] } : undefined,
          event: {
            runId: "next-run",
            sessionId: "pinned-session",
            seq: 1,
            ts: 300,
            stream: "lifecycle",
            data: { phase: "start", startedAt: 300 },
          },
        }),
      ),
    );
    expect(snapshot).toMatchObject({
      ...(active ? { status: "running" } : {}),
      startedAt: 300,
      endedAt: null,
      runtimeMs: null,
      session: {
        ...(active ? { status: "running" } : {}),
        startedAt: 300,
        endedAt: null,
        runtimeMs: null,
      },
    });
    if (!active) {
      expect(snapshot).not.toHaveProperty("status");
      expect(snapshot).not.toHaveProperty("session.status");
    }
    for (const field of [
      "model",
      "modelProvider",
      "activeModel",
      "activeModelProvider",
      "modelOverrideSource",
      "agentRuntime",
    ]) {
      expect(snapshot).not.toHaveProperty(field);
      expect(snapshot).not.toHaveProperty(`session.${field}`);
    }
  },
);

it.each([
  { aborted: false, status: "done" },
  { aborted: true, status: "killed" },
])("keeps terminal $status ahead of retained active cleanup", ({ aborted, status }) => {
  expect(
    buildGatewaySessionSnapshot({
      sessionRow: {
        key: "agent:main:terminal",
        sessionId: "terminal-session",
        kind: "direct",
        createdAt: 50,
        lastReadAt: 150,
        lastActivityAt: 120,
        unread: false,
        updatedAt: 100,
        startedAt: 100,
      },
      includeSession: true,
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
    }),
  ).toMatchObject({
    status,
    unread: true,
    lastActivityAt: 200,
    hasActiveRun: true,
    endedAt: 200,
    runtimeMs: 100,
    session: {
      status,
      unread: true,
      lastActivityAt: 200,
      hasActiveRun: true,
      endedAt: 200,
      runtimeMs: 100,
    },
  });
});

it("publishes prompt budgets and their invalidation to subscribed sessions", () => {
  const status = contextBudgetStatusFixture();
  const row = { key: "agent:main:main", kind: "direct" as const, updatedAt: 2 };
  expect(
    buildGatewaySessionSnapshot({ sessionRow: { ...row, contextBudgetStatus: status } }),
  ).toHaveProperty("contextBudgetStatus", status);
  expect(buildGatewaySessionSnapshot({ sessionRow: row })).toHaveProperty(
    "contextBudgetStatus",
    null,
  );
});

it("publishes and clears device folder bindings in subscribed snapshots", () => {
  const sessionRow = { key: "agent:main:folder", kind: "direct" as const, updatedAt: 1 };
  const deviceFolder = { deviceId: "paired-device", path: "/home/example/project" };
  const previous = buildGatewaySessionSnapshot({ sessionRow: { ...sessionRow, deviceFolder } });
  expect(previous.deviceFolder).toEqual(deviceFolder);
  const cleared = buildGatewaySessionSnapshot({ sessionRow });
  expect({ ...previous, ...cleared }).toMatchObject({ deviceFolder: null });
});
