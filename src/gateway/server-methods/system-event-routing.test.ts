/** System events retain their target and requester across asynchronous admission. */
import "../../test-utils/prepare-compiled-subprocesses.js";
import { randomUUID } from "node:crypto";
import { expectDefined } from "@openclaw/normalization-core";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SYSTEM_PRESENCE_CLEAR_LAST_INPUT_TAG,
  SYSTEM_PRESENCE_LEGACY_CLEAR_LAST_INPUT_SECONDS,
} from "../../../packages/gateway-protocol/src/schema/system-event.js";
import type { SessionEventTarget } from "../../auto-reply/reply/session-event-contract.js";
import {
  loadSessionEntryReadOnly,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.sqlite-entry.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { makeCronJob } from "../../cron/delivery.test-helpers.js";
import { peekSystemEvents, resetSystemEventsForTest } from "../../infra/system-events.js";
import { listSystemPresence } from "../../infra/system-presence.js";
import { createDeferredCore } from "../../shared/deferred.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

const mocks = vi.hoisted(() => ({
  captureTarget: vi.fn(),
  enqueueEvent: vi.fn(),
  readReceipts: vi.fn(),
}));

// mock-isolation: Control target-capture gates and receipts without admitting real reply work.
vi.mock("../../auto-reply/reply/session-event-handoff.js", () => ({
  captureSessionEventTargetForHost: mocks.captureTarget,
  enqueueSessionEventForHost: mocks.enqueueEvent,
}));
// mock-isolation: Use controlled migration receipts for requester revocation without shared-state reads.
vi.mock("../../cron/proactive-job-receipt.js", () => ({
  readDefaultProactiveJobReceiptsAsync: mocks.readReceipts,
}));

import { systemHandlers } from "./system.js";

const systemEvent = expectDefined(systemHandlers["system-event"], "system-event handler");
const setHeartbeats = expectDefined(systemHandlers["set-heartbeats"], "set-heartbeats handler");
let state: OpenClawTestState;
let mainConfig: OpenClawConfig;
let fixedConfig: OpenClawConfig;

function createRequest(params: Record<string, unknown>, cfg = mainConfig) {
  const respond = vi.fn();
  const publishPresence = vi.fn();
  const options = {
    params,
    respond,
    context: { publishPresence, getRuntimeConfig: () => cfg },
  } as unknown as GatewayRequestHandlerOptions;
  return { options, respond, publishPresence };
}

beforeAll(async () => {
  state = await createOpenClawTestState({ label: "system-event-routing", layout: "state-only" });
  mainConfig = { agents: { entries: { main: {} } } };
  fixedConfig = {
    session: { store: state.path("fixed", "shared.sqlite"), scope: "global" },
    agents: {
      ownership: "explicit",
      entries: { ops: {}, research: {} },
      defaults: { sessionStore: { agentId: "ops" } },
    },
  };
  await replaceSessionEntry(
    { agentId: "main", sessionKey: "agent:main:main" },
    { sessionId: "session-main", updatedAt: 1 },
  );
  for (const archivedAt of [0, 1]) {
    await replaceSessionEntry(
      { agentId: "main", sessionKey: `agent:main:archived-${archivedAt}` },
      { sessionId: `session-archived-${archivedAt}`, updatedAt: 1, archivedAt },
    );
  }
  await replaceSessionEntry(
    { agentId: "ops", sessionKey: "global", storePath: fixedConfig.session?.store },
    { sessionId: "session-global", updatedAt: 1 },
  );
});

afterAll(async () => state?.cleanup());

beforeEach(() => {
  resetSystemEventsForTest();
  mocks.captureTarget
    .mockReset()
    .mockImplementation(async (agentId: string, sessionKey: string) => ({
      agentId,
      sessionKey,
      sessionId: "captured-session",
      generation: "captured-generation",
    }));
  mocks.enqueueEvent.mockReset().mockReturnValue({
    id: "event-occurrence",
    cancel: () => false,
    settled: Promise.resolve({ status: "completed", executionStarted: true, delivered: true }),
  });
  mocks.readReceipts.mockReset().mockResolvedValue({
    main: { phase: "complete", jobId: "converted", provisionedAtMs: 1 },
  });
});

afterEach(() => resetSystemEventsForTest());

describe("system-event routing", () => {
  it("admits one ordinary occurrence for a live requested session without duplicating its queue", async () => {
    const sessionKey = "agent:main:main";
    const text = "OpenClaw updated. Welcome the user back.";
    const request = createRequest({ text, sessionKey, wake: true });

    await systemEvent(request.options);

    expect(mocks.captureTarget).toHaveBeenCalledExactlyOnceWith("main", sessionKey);
    expect(mocks.enqueueEvent).toHaveBeenCalledExactlyOnceWith(text, {
      source: "session",
      agentId: "main",
      sessionKey,
      expectedTarget: {
        agentId: "main",
        sessionKey,
        sessionId: "captured-session",
        generation: "captured-generation",
      },
    });
    expect(peekSystemEvents(sessionKey)).toEqual([]);
    expect(request.respond).toHaveBeenCalledExactlyOnceWith(true, { ok: true }, undefined);
  });

  it("routes a bare targeted wake through the persisted fixed-store owner", async () => {
    const request = createRequest(
      { text: "Wake the retained session.", sessionKey: "global", wake: true },
      fixedConfig,
    );

    await systemEvent(request.options);

    expect(mocks.captureTarget).toHaveBeenCalledExactlyOnceWith("ops", "global");
    expect(mocks.enqueueEvent).toHaveBeenCalledExactlyOnceWith(
      "Wake the retained session.",
      expect.objectContaining({ agentId: "ops", sessionKey: "global" }),
    );
    expect(peekSystemEvents("agent:ops:global")).toEqual([]);
    expect(request.respond).toHaveBeenCalledExactlyOnceWith(true, { ok: true }, undefined);
  });

  it.each([false, true])(
    "routes ambient explicit-owner events to global with wake=%s",
    async (wake) => {
      const request = createRequest(
        { text: "System owner notice.", wake },
        {
          session: { scope: "global" },
          agents: {
            ownership: "explicit",
            defaults: { systemAgent: { agentId: "main" } },
            entries: { main: {}, molty: {} },
          },
        },
      );

      await systemEvent(request.options);

      if (wake) {
        expect(mocks.captureTarget).toHaveBeenCalledExactlyOnceWith("main", "global");
        expect(mocks.enqueueEvent).toHaveBeenCalledExactlyOnceWith(
          "System owner notice.",
          expect.objectContaining({ agentId: "main", sessionKey: "global" }),
        );
        expect(peekSystemEvents("agent:main:global")).toEqual([]);
      } else {
        expect(mocks.captureTarget).not.toHaveBeenCalled();
        expect(mocks.enqueueEvent).not.toHaveBeenCalled();
        expect(peekSystemEvents("agent:main:global")).toEqual(["System owner notice."]);
      }
      expect(peekSystemEvents("agent:main:main")).toEqual([]);
      expect(request.respond).toHaveBeenCalledExactlyOnceWith(true, { ok: true }, undefined);
    },
  );

  it("rejects immediate wakes for unconfigured agents", async () => {
    const request = createRequest({ text: "Wake.", sessionKey: "agent:bogus:main", wake: true });

    await systemEvent(request.options);

    expect(peekSystemEvents("agent:bogus:main")).toEqual([]);
    expect(mocks.captureTarget).not.toHaveBeenCalled();
    expect(mocks.enqueueEvent).not.toHaveBeenCalled();
    expect(request.respond).toHaveBeenCalledExactlyOnceWith(
      false,
      undefined,
      expect.objectContaining({ message: 'Unknown agent id "bogus"' }),
    );
  });

  it.each([undefined, 0, 1])(
    "rejects persisted missing or archived sessions (%s)",
    async (archivedAt) => {
      const sessionKey =
        archivedAt === undefined ? "agent:main:missing" : `agent:main:archived-${archivedAt}`;
      const request = createRequest({ text: "Wake.", sessionKey, wake: true });

      await systemEvent(request.options);

      expect(peekSystemEvents(sessionKey)).toEqual([]);
      expect(mocks.captureTarget).not.toHaveBeenCalled();
      expect(mocks.enqueueEvent).not.toHaveBeenCalled();
      expect(request.publishPresence).not.toHaveBeenCalled();
      expect(request.respond).toHaveBeenCalledExactlyOnceWith(
        false,
        undefined,
        expect.objectContaining({ message: `Unknown or archived session "${sessionKey}"` }),
      );
      const entry = loadSessionEntryReadOnly({ agentId: "main", sessionKey });
      if (archivedAt === undefined) {
        expect(entry).toBeUndefined();
      } else {
        expect(entry).toMatchObject({ sessionId: `session-archived-${archivedAt}`, archivedAt });
      }
    },
  );

  it("rejects wake requests mixed with node presence events before admission", async () => {
    const sessionKey = "agent:main:main";
    const request = createRequest({
      text: "Node: Operator Mac",
      deviceId: "device-1",
      sessionKey,
      wake: true,
    });

    await systemEvent(request.options);

    expect(peekSystemEvents(sessionKey)).toEqual([]);
    expect(mocks.captureTarget).not.toHaveBeenCalled();
    expect(mocks.enqueueEvent).not.toHaveBeenCalled();
    expect(request.publishPresence).not.toHaveBeenCalled();
    expect(request.respond).toHaveBeenCalledExactlyOnceWith(
      false,
      undefined,
      expect.objectContaining({ message: "wake is not supported for node presence events" }),
    );
  });

  it("rechecks requester authority after asynchronous target capture", async () => {
    const entered = createDeferredCore();
    const capture = createDeferredCore<SessionEventTarget>();
    mocks.captureTarget.mockImplementationOnce(() => {
      entered.resolve(undefined);
      return capture.promise;
    });
    let current = true;
    const sessionKey = "agent:main:main";
    const instanceId = `revoked-event-${randomUUID()}`;
    const request = createRequest({ text: "Wake.", sessionKey, wake: true, instanceId });
    request.options.hasCurrentClientAuthority = () => current;
    const pending = systemEvent(request.options);
    const refused = expect(pending).rejects.toThrow("Gateway requester authority changed");
    await entered.promise;
    current = false;
    capture.resolve({ sessionId: "session-main", generation: "captured-generation" });
    await refused;

    expect(mocks.enqueueEvent).not.toHaveBeenCalled();
    expect(peekSystemEvents(sessionKey)).toEqual([]);
    expect(listSystemPresence().find((entry) => entry.instanceId === instanceId)).toBeUndefined();
    expect(request.publishPresence).not.toHaveBeenCalled();
    expect(request.respond).not.toHaveBeenCalled();
  });

  it("passes explicit input activity clearing into system presence", async () => {
    const instanceId = `presence-clear-${randomUUID()}`;
    for (const activity of [
      { lastInputSeconds: 5 },
      {
        lastInputSeconds: SYSTEM_PRESENCE_LEGACY_CLEAR_LAST_INPUT_SECONDS,
        tags: [SYSTEM_PRESENCE_CLEAR_LAST_INPUT_TAG],
      },
    ]) {
      await systemEvent(
        createRequest({
          text: "Node: Operator Mac",
          instanceId,
          host: "Operator Mac",
          mode: "ui",
          ...activity,
        }).options,
      );
    }
    const entry = listSystemPresence().find((candidate) => candidate.instanceId === instanceId);
    expect(entry?.lastInputSeconds).toBeUndefined();
  });
});

describe("set-heartbeats compatibility authority", () => {
  it.each(["discovery", "commit"] as const)(
    "rejects revocation during automation %s",
    async (stage) => {
      const entered = createDeferredCore();
      const resume = createDeferredCore();
      let current = true;
      const committed = vi.fn();
      const job = makeCronJob({ id: "converted" });
      const list = vi.fn(async () => {
        if (stage === "discovery") {
          entered.resolve(undefined);
          await resume.promise;
        }
        return [job];
      });
      const update = vi.fn(
        async (_id: string, _patch: unknown, options?: { commitGuard?: () => void }) => {
          if (stage === "commit") {
            entered.resolve(undefined);
            await resume.promise;
          }
          options?.commitGuard?.();
          committed();
          return job;
        },
      );
      const request = createRequest({ enabled: false });
      request.options.hasCurrentClientAuthority = () => current;
      request.options.context = {
        ...request.options.context,
        cron: { list, update },
      } as unknown as GatewayRequestHandlerOptions["context"];
      const pending = setHeartbeats(request.options);
      await entered.promise;
      current = false;
      resume.resolve(undefined);
      await pending;

      expect(committed).not.toHaveBeenCalled();
      expect(update).toHaveBeenCalledTimes(stage === "commit" ? 1 : 0);
      expect(request.respond).toHaveBeenCalledExactlyOnceWith(
        false,
        undefined,
        expect.objectContaining({
          message: expect.stringContaining("Gateway requester authority changed"),
        }),
      );
    },
  );
});
