import "../../test-utils/prepare-compiled-subprocesses.js";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { withGatewayToolCallerIdentity } from "../../agents/tools/gateway-caller-context.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import { writeSessionEntry } from "../../config/sessions/session-accessor.sqlite-entry-store.js";
import { replaceSessionEntrySync } from "../../config/sessions/session-accessor.sqlite-entry.js";
import { rotateAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import {
  enqueueAutomationSystemEvent,
  enqueueSystemEvent,
  peekSystemEventEntries,
  prepareAutomationSystemEvents,
  resetSystemEventsForTest,
} from "../../infra/system-events.js";
import * as gatewayWork from "../../process/gateway-work-admission.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { normalizeSessionDeliveryState } from "../../utils/delivery-context.shared.js";
import {
  assertSessionEventTargetCurrent,
  captureSessionEventTargetForHost,
  enqueueSessionEventForHost,
  prepareSessionEventTargetForHost,
} from "./session-event-handoff.js";

// These cases stop before turn admission. Unexpected dispatch is a failure,
// never a synthetic adoption/settlement supplied by the fixture.
const dispatch = vi.hoisted(() =>
  vi.fn(() => {
    throw new Error("Unexpected reply dispatch for a retired event target");
  }),
);
vi.mock("../dispatch.js", () => ({
  dispatchInboundMessageWithRoutedChannelDispatcher: dispatch,
}));

const continuation = vi.spyOn(gatewayWork, "runWithGatewayIndependentRootWorkContinuation");
const sessionKey = "agent:main:event-origin";
const route = {
  channel: "telegram",
  to: "-100001",
  accountId: "event-account",
  threadId: "42",
};

async function withTargetFixture(
  run: (fixture: OpenClawTestState & { storePath: string }) => Promise<void>,
) {
  await withOpenClawTestState({ label: "session-event-target" }, async (state) => {
    setRuntimeConfigSnapshot({ agents: { entries: { main: { default: true } } } });
    const database = openOpenClawAgentDatabase({ agentId: "main", env: state.env });
    writeSessionEntry(database, sessionKey, {
      sessionId: "original-session",
      lifecycleRevision: "original-revision",
      updatedAt: 1,
      delivery: normalizeSessionDeliveryState({ context: route }),
      permissionMode: "full",
    });
    const storePath = resolveSessionStorePathCore(undefined, { agentId: "main", env: state.env });
    try {
      await run({ ...state, storePath });
    } finally {
      resetSystemEventsForTest();
      gatewayWork.resetGatewayWorkAdmission();
      await Promise.allSettled(
        continuation.mock.results.flatMap((result) =>
          result.type === "return" ? [result.value] : [],
        ),
      );
      expect(gatewayWork.getActiveGatewayRootWorkCount()).toBe(0);
    }
  });
}

beforeEach(() => {
  continuation.mockClear();
  dispatch.mockClear();
  resetSystemEventsForTest();
  gatewayWork.resetGatewayWorkAdmission();
});

afterAll(() => {
  continuation.mockRestore();
});

describe("session event target custody", () => {
  it("captures the original store, route and tool ceiling across asynchronous lookup", async () => {
    await withTargetFixture(async ({ env, path, storePath }) => {
      const suppliedEnv = { ...env };
      const toolsAllow = ["read", "exec"];
      let invocationActive = true;
      let producerActive = true;
      const targetPromise = withGatewayToolCallerIdentity(
        {
          agentId: "main",
          sessionKey,
          sessionEventToolsAllow: toolsAllow,
          receiptAuthority: () => invocationActive,
        },
        () =>
          captureSessionEventTargetForHost("main", sessionKey, {
            env: suppliedEnv,
            assertCurrent: () => {
              if (!producerActive) {
                throw new Error("Background producer retired");
              }
            },
          }),
      );
      suppliedEnv.OPENCLAW_STATE_DIR = path("later-state");
      const target = await targetPromise;
      toolsAllow.push("message");
      invocationActive = false;

      expect(target).toMatchObject({
        agentId: "main",
        sessionKey,
        sessionId: "original-session",
        lifecycleRevision: "original-revision",
        storePath,
        deliveryContext: route,
        settings: { permissionMode: "full" },
        toolsAllow: ["read", "exec"],
      });
      // The independently owned producer outlives its creating tool invocation.
      expect(() => assertSessionEventTargetCurrent(target)).not.toThrow();
      producerActive = false;
      expect(() => assertSessionEventTargetCurrent(target)).toThrow("Background producer retired");
      expect(() =>
        enqueueSessionEventForHost("Process completed", {
          agentId: "main",
          sessionKey,
          source: "exec",
          expectedTarget: target,
        }),
      ).toThrow("Background producer retired");
      expect(peekSystemEventEntries(sessionKey)).toEqual([]);
    });
  });

  it.each(["invocation", "producer"] as const)(
    "refuses a target when its %s retires during asynchronous capture",
    async (owner) => {
      await withTargetFixture(async ({ env }) => {
        let active = true;
        const capture = withGatewayToolCallerIdentity(
          { agentId: "main", sessionKey, receiptAuthority: () => owner !== "invocation" || active },
          () =>
            captureSessionEventTargetForHost("main", sessionKey, {
              env,
              assertCurrent: () => {
                if (owner === "producer" && !active) {
                  throw new Error("Background producer retired");
                }
              },
            }),
        );
        active = false;
        await expect(capture).rejects.toThrow(
          owner === "invocation" ? "no longer owns its invocation" : "Background producer retired",
        );
        expect(peekSystemEventEntries(sessionKey)).toEqual([]);
      });
    },
  );

  it.each(["session reset", "lifecycle replacement"] as const)(
    "rejects a captured target after %s before dispatching a turn",
    async (change) => {
      await withTargetFixture(async ({ env, storePath }) => {
        const target = await captureSessionEventTargetForHost("main", sessionKey, { env });
        replaceSessionEntrySync(
          { agentId: "main", storePath, sessionKey, env },
          {
            sessionId: change === "session reset" ? "replacement-session" : "original-session",
            lifecycleRevision: "replacement-revision",
            updatedAt: 2,
            delivery: normalizeSessionDeliveryState({
              context: { ...route, to: "replacement-target" },
            }),
          },
        );
        const receipt = enqueueSessionEventForHost("Process completed", {
          agentId: "main",
          sessionKey,
          source: "exec",
          expectedTarget: target,
        });

        await expect(receipt.settled).resolves.toMatchObject({
          status: "failed",
          executionStarted: false,
          delivered: false,
          error: expect.stringContaining("original session generation"),
        });
        expect(dispatch).not.toHaveBeenCalled();
        expect(peekSystemEventEntries(sessionKey)).toEqual([]);
      });
    },
  );

  it.each(["store replacement", "Gateway restart"] as const)(
    "rejects retained target reuse after %s without creating another occurrence",
    async (change) => {
      await withTargetFixture(async ({ env, path }) => {
        const target = await captureSessionEventTargetForHost("main", sessionKey, { env });
        if (change === "store replacement") {
          setRuntimeConfigSnapshot({
            agents: { entries: { main: { default: true } } },
            session: { store: path("replacement.sqlite") },
          });
        } else {
          rotateAgentEventLifecycleGeneration();
        }
        expect(() =>
          enqueueSessionEventForHost("Process completed", {
            agentId: "main",
            sessionKey,
            source: "exec",
            expectedTarget: target,
          }),
        ).toThrow(change === "store replacement" ? "reset or replaced" : "stale gateway lifecycle");
        expect(dispatch).not.toHaveBeenCalled();
        expect(peekSystemEventEntries(sessionKey)).toEqual([]);
      });
    },
  );

  it("retires a reset generation's deferred notice without poisoning its automation", async () => {
    await withTargetFixture(async ({ env, storePath }) => {
      const retiredTarget = await captureSessionEventTargetForHost("main", sessionKey, { env });
      enqueueAutomationSystemEvent(
        "Old session notice",
        { sessionKey },
        {
          jobId: "scheduled-review",
          assertCurrent: () => assertSessionEventTargetCurrent(retiredTarget),
          prepare: () => prepareSessionEventTargetForHost(retiredTarget),
        },
      );
      replaceSessionEntrySync(
        { agentId: "main", storePath, sessionKey, env },
        {
          sessionId: "replacement-session",
          lifecycleRevision: "replacement-revision",
          updatedAt: 2,
        },
      );
      const currentTarget = await captureSessionEventTargetForHost("main", sessionKey, { env });
      const currentOwner = {
        assertCurrent: () => assertSessionEventTargetCurrent(currentTarget),
        prepare: () => prepareSessionEventTargetForHost(currentTarget),
      };
      enqueueAutomationSystemEvent(
        "Current session notice",
        { sessionKey },
        {
          ...currentOwner,
          jobId: "scheduled-review",
        },
      );
      enqueueAutomationSystemEvent(
        "Other automation notice",
        { sessionKey },
        {
          ...currentOwner,
          jobId: "other-review",
        },
      );
      enqueueSystemEvent("Ordinary session notice", { sessionKey });

      const prepared = await prepareAutomationSystemEvents(sessionKey, "scheduled-review");
      try {
        expect(prepared.events.map((event) => event.text)).toEqual(["Current session notice"]);
        prepared.start();
        expect(peekSystemEventEntries(sessionKey).map((event) => event.text)).toEqual([
          "Other automation notice",
          "Ordinary session notice",
        ]);
      } finally {
        prepared.release();
      }
      const nextRun = await prepareAutomationSystemEvents(sessionKey, "scheduled-review");
      try {
        expect(nextRun.events).toEqual([]);
        nextRun.start();
      } finally {
        nextRun.release();
      }
      expect(dispatch).not.toHaveBeenCalled();
    });
  });

  it("settles a pending occurrence as cancelled when ephemeral queues close", async () => {
    await withTargetFixture(async ({ env }) => {
      const target = await captureSessionEventTargetForHost("main", sessionKey, { env });
      const suspension = gatewayWork.tryBeginGatewaySuspendAdmission(() => {});
      expect(suspension?.commit()).toBe(true);
      try {
        const receipt = enqueueSessionEventForHost("Process completed", {
          agentId: "main",
          sessionKey,
          source: "exec",
          expectedTarget: target,
        });
        expect(peekSystemEventEntries(sessionKey).map((event) => event.id)).toEqual([receipt.id]);
        resetSystemEventsForTest();

        await expect(receipt.settled).resolves.toMatchObject({
          status: "cancelled",
          executionStarted: false,
          delivered: false,
        });
        expect(receipt.cancel()).toBe(false);
        expect(gatewayWork.getGatewaySuspendAdmissionPhase()).toBe("prepared");
        expect(peekSystemEventEntries(sessionKey)).toEqual([]);
        expect(dispatch).not.toHaveBeenCalled();
      } finally {
        suspension?.release();
      }
    });
  });

  it("releases an occurrence when Gateway restart admission refuses the producer", async () => {
    await withTargetFixture(async ({ env }) => {
      const target = await captureSessionEventTargetForHost("main", sessionKey, { env });
      gatewayWork.markGatewayRestartDraining();
      const receipt = enqueueSessionEventForHost("Process completed", {
        agentId: "main",
        sessionKey,
        source: "restart",
        expectedTarget: target,
      });

      await expect(receipt.settled).resolves.toMatchObject({
        status: "failed",
        executionStarted: false,
        delivered: false,
        error: expect.stringContaining("GatewayDrainingError"),
      });
      expect(peekSystemEventEntries(sessionKey)).toEqual([]);
      expect(dispatch).not.toHaveBeenCalled();
    });
  });
});
