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
import { settleWorkspaceRuns } from "../server.sessions.create.projects.test-support.js";
import {
  agentDiscoveryMock,
  dispatchInboundMessageMock,
  gatewayReplyMock,
  prepareGatewayReplyRuntimeForTest,
  testState,
} from "../test-helpers.js";
import {
  directSessionReq,
  getGatewayConfigModule,
  setupGatewaySessionsHandlerTestHarness,
} from "../test/server-sessions.test-helpers.js";
import type { GatewayClient } from "./types.js";

const { createSessionStoreDir } = setupGatewaySessionsHandlerTestHarness();
const client: GatewayClient = {
  connId: "created-thinking-proof",
  connect: {
    minProtocol: 1,
    maxProtocol: 1,
    role: "operator",
    scopes: ["operator.read", "operator.write", "operator.admin"],
    client: { id: "openclaw-control-ui", version: "test", platform: "test", mode: "webchat" },
  },
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
    const replyEntered = createDeferred();
    const releaseReply = createDeferred();
    const replyFinished = createDeferred();
    const releaseFirstList = createDeferred();
    const firstListRead = createDeferred();
    const failures: unknown[] = [];
    const order: string[] = [];
    const key = "agent:main:dashboard:created-thinking-proof";
    const scope = { agentId: "main", sessionKey: key, storePath };
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
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
      } catch (error) {
        failures.push(error);
        throw error;
      } finally {
        replyFinished.resolve(undefined);
      }
    });
    let listCalls = 0;
    let creationReturned = false;
    const gatewayClient = createTestGatewayClient(async (method, params) => {
      if (
        method !== "sessions.create" &&
        method !== "sessions.list" &&
        method !== "sessions.patch"
      ) {
        throw new Error(`Unexpected request: ${method}`);
      }
      if (!isRecord(params)) {
        throw new Error(`Expected object parameters for ${method}`);
      }
      const response = await directSessionReq(method, params, {
        context: { ...context },
        client,
        isWebchatConnect: () => true,
      });
      if (!response.ok) {
        throw new Error(response.error?.message ?? `${method} failed`);
      }
      if (method === "sessions.create") {
        order.push("create-ack");
        creationReturned = true;
      }
      if (method === "sessions.list" && creationReturned) {
        listCalls += 1;
        order.push(`list-${listCalls}-read`);
        if (listCalls === 1) {
          firstListRead.resolve(undefined);
          await releaseFirstList.promise;
        }
      }
      return response.payload;
    });
    const { gateway, emitEvent } = createGatewayHarness(gatewayClient);
    const sessions = createTestSessionCapability(gateway);
    try {
      await sessions.refresh({ agentId: "main", force: true });
      expect(sessions.state.result?.sessions.some((row) => row.key === key)).toBe(false);
      const created = await withTimeout(
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
        15_000,
        "created-claim create response",
      );
      expect(created).toMatchObject({
        key,
        initialRun: { status: "started" },
        entry: { thinkingLevel: "high", updatedAt: Date.now() },
      });
      expect(loadSessionEntry(scope)).toMatchObject({
        thinkingLevel: "high",
        updatedAt: Date.now(),
      });
      expect(sessions.think(key, "main")).toBe("high");
      await withTimeout(replyEntered.promise, 15_000, "created-claim reply admission");
      await withTimeout(firstListRead.promise, 15_000, "created-claim first list");
      releaseReply.resolve(undefined);
      await withTimeout(replyFinished.promise, 15_000, "created-claim directive completion");
      await settleWorkspaceRuns(context, storePath, key);
      expect(failures).toEqual([]);
      expect(runModel).not.toHaveBeenCalled();
      expect(loadSessionEntry(scope)).toMatchObject({
        sessionId: created?.entry?.sessionId,
        thinkingLevel: "low",
        updatedAt: created?.entry?.updatedAt,
      });
      expect(deliveredEvents.filter(({ event }) => event === "sessions.changed")).toEqual([]);
      if (mode === "delivered-event") {
        subscribers.add("created-thinking-proof");
        const changed = await directSessionReq(
          "sessions.patch",
          { key, agentId: "main", thinkingLevel: "low" },
          { context: { ...context }, client, isWebchatConnect: () => true },
        );
        expect(changed.ok).toBe(true);
        expect(deliveredEvents).toContainEqual({
          event: "sessions.changed",
          payload: expect.objectContaining({
            sessionKey: key,
            sessionId: created?.entry?.sessionId,
            agentId: "main",
            thinkingLevel: "low",
            updatedAt: created?.entry?.updatedAt,
          }),
        });
        expect(sessions.think(key, "main")).toBe("low");
        releaseFirstList.resolve(undefined);
        await vi.waitFor(() =>
          expect(
            sessions.state.result?.sessions.find((row) => row.key === key)?.thinkingLevel,
          ).toBe("high"),
        );
        // This real high read was issued before the low event replaced the unlisted claim.
        expect(sessions.think(key, "main")).toBe("low");
      } else if (mode === "ui-patch") {
        const patched = sessions.patch(key, { thinkingLevel: "low" }, { agentId: "main" });
        await vi.waitFor(() => expect(sessions.think(key, "main")).toBeUndefined());
        releaseFirstList.resolve(undefined);
        await patched;
      }
      if (mode !== "ui-patch") {
        const refresh = sessions.refresh({ agentId: "main", force: true });
        releaseFirstList.resolve(undefined);
        await refresh;
      }
      const row = sessions.state.result?.sessions.find((entry) => entry.key === key);
      expect(row).toMatchObject({
        sessionId: created?.entry?.sessionId,
        thinkingLevel: "low",
        updatedAt: created?.entry?.updatedAt,
      });
      expect(order).toEqual(["create-ack", "list-1-read", "directive-complete", "list-2-read"]);
      expect(sessions.think(key, "main")).toBeUndefined();
    } finally {
      releaseReply.resolve(undefined);
      releaseFirstList.resolve(undefined);
      try {
        await settleWorkspaceRuns(context, storePath, key, true);
      } finally {
        sessions.dispose();
        gatewayReplyMock.mockReset();
        runModel.mockRestore();
        clock.mockRestore();
      }
    }
  },
);
