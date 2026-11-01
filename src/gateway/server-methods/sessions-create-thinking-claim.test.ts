import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, test, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  createGatewayHarness,
  createTestSessionCapability,
} from "../../../ui/src/lib/sessions/session-capability.test-support.ts";
import { createTestGatewayClient } from "../../../ui/src/test-helpers/gateway-client.ts";
import * as embeddedAgent from "../../agents/embedded-agent.js";
import { getReplyFromConfig } from "../../auto-reply/reply/get-reply.js";
import { loadSessionEntry } from "../../config/sessions/session-accessor.js";
import { withTimeout } from "../../infra/fs-safe.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import {
  settleWorkspaceRuns,
  successfulSessionRequest,
} from "../server.sessions.create.projects.test-support.js";
import { sharingPolicyClient } from "../session-sharing.test-utils.js";
import {
  agentDiscoveryMock,
  dispatchInboundMessageMock,
  gatewayReplyMock,
  prepareGatewayReplyRuntimeForTest,
  testState,
} from "../test-helpers.js";
import {
  getGatewayConfigModule,
  setupGatewaySessionsHandlerTestHarness,
} from "../test/server-sessions.test-helpers.js";
import { flushPendingSessionsChangedEvents } from "./session-change-event.js";
import { initializeSessionReadContext } from "./sessions-read-cache.test-support.js";

const fixedNow = vi.hoisted(() => 1_800_000_000_000);
const waitFor = <T>(promise: Promise<T>, label: string) =>
  withTimeout(promise, 15_000, `created-claim ${label}`);

vi.mock("../../infra/worker-cpu.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../infra/worker-cpu.js")>();
  // The same-version claim regression needs one clock across the host and real workers.
  const preload = `Date.now = () => ${fixedNow};`;
  return {
    ...actual,
    createCpuTrackedWorker(...args: Parameters<typeof actual.createCpuTrackedWorker>) {
      const [filename, options] = args;
      return actual.createCpuTrackedWorker(filename, {
        ...options,
        execArgv: [
          ...(options?.execArgv ?? []),
          "--import",
          `data:text/javascript,${encodeURIComponent(preload)}`,
        ],
      });
    },
  };
});

const { createSessionStoreDir } = setupGatewaySessionsHandlerTestHarness();
const client = {
  ...sharingPolicyClient({ scopes: ["operator.read", "operator.write", "operator.admin"] }),
  connId: "created-thinking-proof",
};

test.each(["later-read", "delivered-event", "ui-patch"])(
  "uses the real initial thinking directive after its created claim at the same timestamp (%s)",
  async (mode) => {
    const { storePath } = await createSessionStoreDir();
    testState.agentConfig = { model: { primary: "openai/gpt-5.5" } };
    agentDiscoveryMock.enabled = true;
    agentDiscoveryMock.models = [
      { id: "gpt-5.5", name: "GPT-5.5", provider: "openai", reasoning: true },
    ];
    await prepareGatewayReplyRuntimeForTest({ force: true });
    const { getRuntimeConfig } = await getGatewayConfigModule();
    const subscribers = new Set<string>();
    const deliveredEvents: Array<{ event: string; payload: unknown }> = [];
    const context = createDirectChatContext({
      getRuntimeConfig,
      getSessionEventSubscriberConnIds: () => subscribers,
      broadcastToConnIds: (event, payload) => {
        deliveredEvents.push({ event, payload });
        emitEvent({ type: "event", event, payload });
      },
    });
    const requestOptions = () => ({
      context: { ...context },
      client,
      isWebchatConnect: () => true,
    });
    const replyEntered = createDeferred();
    const releaseReply = createDeferred();
    const replyFinished = createDeferred();
    const releaseFirstList = createDeferred();
    const firstListRead = createDeferred();
    const releaseSecondList = createDeferred();
    const secondListRead = createDeferred();
    const lowListPublished = createDeferred();
    const order: string[] = [];
    const key = "agent:main:dashboard:created-thinking-proof";
    const identity = { agentId: "main", sessionKey: key };
    const scope = { ...identity, storePath };
    const clock = vi.spyOn(Date, "now").mockReturnValue(fixedNow);
    const runModel = vi
      .spyOn(embeddedAgent, "runEmbeddedAgent")
      .mockRejectedValue(new Error("pure thinking directive must not invoke a model"));
    dispatchInboundMessageMock.mockReset();
    gatewayReplyMock.mockImplementation(async (...args) => {
      replyEntered.resolve(undefined);
      await releaseReply.promise;
      try {
        const result = await getReplyFromConfig(...args);
        order.push("directive-complete");
        return result;
      } finally {
        replyFinished.resolve(undefined);
      }
    });
    let listCalls = 0;
    const gatewayClient = createTestGatewayClient(async (method, params) => {
      if (
        !isRecord(params) ||
        (method !== "sessions.create" && method !== "sessions.list" && method !== "sessions.patch")
      ) {
        throw new Error(`Unexpected request: ${method}`);
      }
      const payload = await successfulSessionRequest(method, params, requestOptions());
      if (method === "sessions.create") {
        order.push("create-ack");
      }
      if (method === "sessions.list" && order.includes("create-ack")) {
        listCalls += 1;
        order.push(`list-${listCalls}-read`);
        if (listCalls === 1) {
          firstListRead.resolve(undefined);
          await releaseFirstList.promise;
        } else if (listCalls === 2 && mode === "delivered-event") {
          secondListRead.resolve(undefined);
          await releaseSecondList.promise;
        }
      }
      return payload;
    });
    const requests = vi.spyOn(gatewayClient, "request");
    const { gateway, emitEvent } = createGatewayHarness(gatewayClient);
    const sessions = createTestSessionCapability(gateway);
    const refresh = () => sessions.refresh({ agentId: "main", rowMode: "compact", force: true });
    const row = () => sessions.state.result?.sessions.find((entry) => entry.key === key);
    const unsubscribe = sessions.subscribe(() => {
      if (row()?.thinkingLevel === "low") {
        lowListPublished.resolve(undefined);
      }
    });
    try {
      await initializeSessionReadContext(context);
      // Thinking reconciliation needs compact detail facts, not the sidebar display projection.
      await refresh();
      expect(row()).toBeUndefined();
      const created = await waitFor(
        sessions.createResult(
          {
            key,
            agentId: "main",
            model: "openai/gpt-5.5",
            thinkingLevel: "high",
            message: "/think low",
          },
          { reconciliation: "background" },
        ),
        "create response",
      );
      const highEntry = { thinkingLevel: "high", updatedAt: Date.now() };
      expect(created, sessions.state.error ?? undefined).toMatchObject({
        key,
        initialRun: { status: "started" },
        entry: highEntry,
      });
      expect(loadSessionEntry(scope)).toMatchObject(highEntry);
      expect(sessions.think(key, "main")).toBe("high");
      await waitFor(replyEntered.promise, "reply admission");
      await waitFor(firstListRead.promise, "first list");
      releaseReply.resolve(undefined);
      await waitFor(replyFinished.promise, "directive completion");
      await settleWorkspaceRuns(context, storePath, key);
      expect(runModel).not.toHaveBeenCalled();
      const lowEntry = {
        sessionId: created?.entry?.sessionId,
        thinkingLevel: "low",
        updatedAt: created?.entry?.updatedAt,
      };
      expect(loadSessionEntry(scope)).toMatchObject(lowEntry);
      expect(deliveredEvents.filter(({ event }) => event === "sessions.changed")).toEqual([]);
      if (mode === "delivered-event") {
        subscribers.add("created-thinking-proof");
        await successfulSessionRequest(
          "sessions.patch",
          { key, agentId: "main", thinkingLevel: "low" },
          requestOptions(),
        );
        await flushPendingSessionsChangedEvents();
        expect(deliveredEvents).toContainEqual({
          event: "sessions.changed",
          payload: expect.objectContaining({ ...identity, ...lowEntry }),
        });
        expect(sessions.think(key, "main")).toBe("low");
        releaseFirstList.resolve(undefined);
        await waitFor(secondListRead.promise, "successor low list");
        // Hold canonical low until the older high response has faced the newer event claim.
        expect(row()).toMatchObject(highEntry);
        expect(sessions.think(key, "main")).toBe("low");
        releaseSecondList.resolve(undefined);
        await waitFor(lowListPublished.promise, "canonical low publication");
      } else if (mode === "ui-patch") {
        const patched = sessions.patch(key, { thinkingLevel: "low" }, { agentId: "main" });
        // Observe the real PATCH acknowledgement, not a polling deadline before it settles.
        await requests.mock.results.at(-1)?.value;
        expect(sessions.think(key, "main")).toBeUndefined();
        releaseFirstList.resolve(undefined);
        await patched;
      }
      if (mode === "later-read") {
        const refreshed = refresh();
        releaseFirstList.resolve(undefined);
        await refreshed;
      }
      expect(row()).toMatchObject(lowEntry);
      expect(order).toEqual(["create-ack", "list-1-read", "directive-complete", "list-2-read"]);
      expect(sessions.think(key, "main")).toBeUndefined();
      expect(sessions.think(key, "main") ?? row()?.thinkingLevel).toBe("low");
    } finally {
      releaseSecondList.resolve(undefined);
      releaseReply.resolve(undefined);
      releaseFirstList.resolve(undefined);
      try {
        await settleWorkspaceRuns(context, storePath, key, true);
        if (mode === "delivered-event" && listCalls >= 2) {
          await waitFor(lowListPublished.promise, "successor cleanup");
        }
      } finally {
        unsubscribe();
        sessions.dispose();
        requests.mockRestore();
        gatewayReplyMock.mockReset();
        runModel.mockRestore();
        clock.mockRestore();
      }
    }
  },
);
