import { setImmediate as nextEventLoopTurn } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sessionChanges } from "../sessions/session-row-changes.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
import type { ControlUiSessionPullRequests as Snapshot } from "./control-ui-contract.js";
import {
  createTestControlUiSessionPrSubscriptions,
  createTestSessionPrReadSource,
  prepareTestSessionPrRead,
} from "./control-ui-session-pr-subscriptions.test-support.js";
import type { PreparedRepositorySessionRead } from "./repository-session-read.types.js";

const CHANGED_EVENT = "controlUi.sessionPullRequests.changed";

const READY: Snapshot = { pullRequests: [], rateLimited: false };

let running: Awaited<ReturnType<typeof createTestControlUiSessionPrSubscriptions>> | undefined;
let broadcastToConnIds: ReturnType<typeof vi.fn<Options["broadcastToConnIds"]>>;
let load: ReturnType<typeof vi.fn<NonNullable<Options["load"]>>>;
let clock: ReturnType<typeof createGatewaySchedulerClock>;

beforeEach(() => {
  broadcastToConnIds = vi.fn<Options["broadcastToConnIds"]>();
  load = vi.fn<NonNullable<Options["load"]>>(async () => READY);
  clock = createGatewaySchedulerClock(Date.now());
});

afterEach(async () => {
  await running?.stop();
  running = undefined;
  vi.useRealTimers();
});

type Options = Parameters<typeof createTestControlUiSessionPrSubscriptions>[0];
async function start(options: Omit<Options, "scheduler" | "broadcastToConnIds"> = {}) {
  running = await createTestControlUiSessionPrSubscriptions({
    scheduler: createTestGatewayScheduler(clock.clock),
    broadcastToConnIds,
    load,
    ...options,
  });
  return running;
}

function publication(connId: string, key = "session", rateLimited = false) {
  return [
    CHANGED_EVENT,
    {
      sessions: {
        [key]: { ...READY, rateLimited, status: rateLimited ? "rate-limited" : "ready" },
      },
    },
    new Set([connId]),
    { sessionKeys: [key], agentId: "main" },
  ] as const;
}

function expectPublication(connId: string, key = "session", rateLimited = false) {
  expect(broadcastToConnIds).toHaveBeenCalledExactlyOnceWith(
    ...publication(connId, key, rateLimited),
  );
}

describe("control UI session PR subscriptions", () => {
  it("reuses current watcher grants across streaming reads and reacquires changed targets", async () => {
    const readSource = createTestSessionPrReadSource();
    let revision = 0;
    let visible = true;
    const readCurrent = vi.fn(async (): Promise<PreparedRepositorySessionRead | undefined> => {
      if (!visible) {
        return undefined;
      }
      const captured = revision;
      return prepareTestSessionPrRead({
        session: { sessionKey: "session", agentId: "main", sessionId: "session-id" },
        identity: `session-${captured}`,
        readSource,
        source: null,
        assertCurrent: () => {
          if (!visible || captured !== revision) {
            throw new Error("Watcher grant changed");
          }
        },
      });
    });
    const active = await start({ prepareRead: async () => readCurrent });
    await active.replace("reader", ["session"]);
    readCurrent.mockClear();
    broadcastToConnIds.mockClear();
    for (let index = 0; index < 20; index++) {
      sessionChanges.emit({ sessionKey: "streaming-child", scope: "transcript" });
      await nextEventLoopTurn();
      await active.pollNow();
    }
    expect(readCurrent).not.toHaveBeenCalled();
    expect(broadcastToConnIds).not.toHaveBeenCalled();

    revision++;
    await active.pollNow();
    expect(readCurrent).toHaveBeenCalledOnce();
    expectPublication("reader");

    visible = false;
    readCurrent.mockClear();
    broadcastToConnIds.mockClear();
    await active.pollNow();
    expect(readCurrent).toHaveBeenCalledOnce();
    expect(broadcastToConnIds).not.toHaveBeenCalled();
    readCurrent.mockClear();
    await active.pollNow();
    expect(readCurrent).not.toHaveBeenCalled();
  });

  it.each([
    { facts: "category", invalidated: undefined, refresh: false },
    { facts: "participants", invalidated: undefined, refresh: false },
    { facts: undefined, invalidated: "category", refresh: false },
    { facts: "category", invalidated: true, refresh: true },
    { facts: "unchanged", invalidated: true, refresh: true },
    { facts: "participants", invalidated: true, refresh: true },
  ] as const)(
    "refreshes=$refresh for facts=$facts, invalidated=$invalidated",
    async ({ facts, invalidated, refresh }) => {
      const readSource = createTestSessionPrReadSource();
      let revision = 0;
      const readCurrent = vi.fn(async () => {
        const captured = revision;
        return prepareTestSessionPrRead({
          session: { sessionKey: "session", agentId: "main", sessionId: "session-id" },
          identity: "session",
          readSource,
          source: null,
          assertCurrent() {
            if (captured !== revision) {
              throw new Error("Watcher grant changed");
            }
          },
        });
      });
      const active = await start({ prepareRead: async () => readCurrent });
      await active.replace("reader", ["session"]);
      readCurrent.mockClear();
      broadcastToConnIds.mockClear();
      if (invalidated === true) {
        revision++;
      }
      sessionChanges.emit({
        sessionKey: "session",
        facts:
          facts === "category"
            ? { kind: facts, sessionId: "session-id", category: "work" }
            : facts && { kind: facts },
        factsInvalidated: invalidated,
      });
      await nextEventLoopTurn();
      expect(readCurrent.mock.calls.length > 0).toBe(refresh);
      expect(broadcastToConnIds).not.toHaveBeenCalled();
    },
  );
});
