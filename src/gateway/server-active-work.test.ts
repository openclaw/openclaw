// Covers server-local chat, cron watcher, queued-turn, and terminal blockers.
import { describe, expect, it, vi } from "vitest";
import { createGatewayActiveWorkSnapshot } from "../infra/gateway-active-work.js";
import { createGatewayServerActiveWorkInspectors } from "./server-active-work.js";
import type { GatewayRequestContext } from "./server-methods/shared-types.js";
import { TerminalSessionManager } from "./terminal/session-manager.js";
import {
  agentTerminalOwner,
  baseOpenRequest,
  makeFakePty,
} from "./terminal/session-manager.test-helpers.js";

vi.mock("../cron/active-jobs.js", () => ({
  getActiveCronJobCount: vi.fn(() => 2),
}));

vi.mock("../cron/service/active-run-cancellation.js", () => ({
  getSuspensionVisibleCronTaskRunCount: vi.fn(() => 4),
}));

function controller(aborted = false): AbortController {
  const value = new AbortController();
  if (aborted) {
    value.abort();
  }
  return value;
}

describe("gateway server active work inspectors", () => {
  it("filters completed chat entries while retaining persistence and watcher blockers", () => {
    const context = {
      cron: { getSuspensionBlockerCount: () => 1 },
      chatAbortControllers: new Map([
        ["active", { controller: controller(), sessionKey: "agent:main:active" }],
        ["aborted", { controller: controller(true), sessionKey: "agent:main:aborted" }],
        [
          "persisting",
          {
            controller: controller(),
            sessionKey: "agent:main:persisting",
            registrationCleanupRequested: true,
            controlUiVisible: true,
            projectSessionTerminalPending: true,
          },
        ],
      ]),
      chatQueuedTurns: new Map([
        ["queued", { controller: controller() }],
        ["cancelled", { controller: controller(true) }],
      ]),
      terminalSessions: { size: 2 },
    } as unknown as Pick<
      GatewayRequestContext,
      "chatAbortControllers" | "chatQueuedTurns" | "cron" | "terminalSessions"
    >;

    const inspectors = createGatewayServerActiveWorkInspectors(context);

    expect(inspectors.getCronRuns?.()).toBe(5);
    expect(inspectors.getChatRuns?.()).toBe(1);
    expect(inspectors.getQueuedTurns?.()).toBe(1);
    expect(inspectors.getTerminalPersistence?.()).toBe(1);
    expect(inspectors.getTerminalSessions?.()).toBe(2);
    expect(createGatewayActiveWorkSnapshot(inspectors).blockers).toEqual(
      expect.arrayContaining([
        {
          kind: "chat-run",
          count: 1,
          message: "1 active chat run(s): run=active session=agent:main:active",
        },
        {
          kind: "terminal-persistence",
          count: 1,
          message:
            "1 pending terminal session write(s): run=persisting session=agent:main:persisting",
        },
      ]),
    );
  });

  it("bounds and redacts terminal diagnostics without exposing session keys", () => {
    const now = Date.now();
    const context = {
      cron: {},
      chatQueuedTurns: new Map(),
      chatAbortControllers: new Map(
        Array.from({ length: 10 }, (_, index) => [
          index === 0 ? "run-0 password=synthetic-secret" : "run-" + index + "\n" + "x".repeat(300),
          {
            controller: controller(),
            sessionKey: "private-session-" + index,
            projectSessionTerminalPending: true,
            projectSessionTerminalObservedAt: now - index * 1_000,
          },
        ]),
      ),
    } as unknown as Parameters<typeof createGatewayServerActiveWorkInspectors>[0];
    const diagnostics =
      createGatewayServerActiveWorkInspectors(context).getTerminalPersistenceDiagnostics?.();
    expect(diagnostics?.oldestAgeMs).toBeGreaterThanOrEqual(9_000);
    expect(diagnostics?.runIds).toHaveLength(8);
    expect(diagnostics?.runIds.every((id) => id.length <= 256 && !/\p{Cc}/u.test(id))).toBe(true);
    expect(JSON.stringify(diagnostics)).not.toContain("synthetic-secret");
    expect(JSON.stringify(diagnostics)).not.toContain("private-session");
    const first = context.chatAbortControllers.values().next().value!;
    first.projectSessionTerminalObservedAt = undefined;
    expect(
      createGatewayServerActiveWorkInspectors(context).getTerminalPersistenceDiagnostics?.()
        .oldestAgeMs,
    ).toBeNull();
  });

  it("drops the raw terminal-session blocker count during an agent session drain", async () => {
    const drainingPty = makeFakePty();
    const persistentPty = makeFakePty();
    const ptys = [drainingPty, persistentPty];
    const terminalSessions = new TerminalSessionManager({
      emit: vi.fn(),
      spawn: async () => ptys.shift() ?? makeFakePty(),
    });
    const drainingOwner = agentTerminalOwner("agent:main:archive-target", "archived-session");
    await terminalSessions.open(
      baseOpenRequest({
        owner: drainingOwner,
      }),
    );
    await terminalSessions.open(baseOpenRequest({ owner: agentTerminalOwner("agent:main:main") }));
    const inspectors = createGatewayServerActiveWorkInspectors({
      cron: {},
      chatAbortControllers: new Map(),
      chatQueuedTurns: new Map(),
      terminalSessions,
    } as unknown as Pick<
      GatewayRequestContext,
      "chatAbortControllers" | "chatQueuedTurns" | "cron" | "terminalSessions"
    >);

    expect(inspectors.getTerminalSessions?.()).toBe(2);
    const drain = terminalSessions.beginAgentSessionDrain(drainingOwner);
    try {
      expect(inspectors.getTerminalSessions?.()).toBe(1);
      expect(drainingPty.killed).toBe(true);
      expect(persistentPty.killed).toBe(false);
      expect(drain.hasWork()).toBe(true);
      drainingPty.emitExit(0);
      await expect(drain.drained).resolves.toBeUndefined();
      expect(drain.hasWork()).toBe(false);
      expect(inspectors.getTerminalSessions?.()).toBe(1);
    } finally {
      drain.release();
      terminalSessions.disposeAll();
      drainingPty.emitExit(0);
      persistentPty.emitExit(0);
    }
  });
});
