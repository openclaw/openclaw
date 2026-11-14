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

type TitleReadFixture = {
  key: string;
  storePath: string;
  identity: ReturnType<typeof createDeferred<string>>;
  entered: ReturnType<typeof createDeferred>;
  release: ReturnType<typeof createDeferred>;
  tasks: Promise<boolean>[];
};
const titleReadFixture = vi.hoisted(() => {
  let current: TitleReadFixture | undefined;
  return {
    get current() {
      return current;
    },
    set(value: TitleReadFixture | undefined) {
      current = value;
    },
  };
});

vi.mock("../session-transcript-title-reader.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../session-transcript-title-reader.js")>();
  return {
    ...actual,
    async readSessionTitleFieldsFromTranscriptAsync(
      ...args: Parameters<typeof actual.readSessionTitleFieldsFromTranscriptAsync>
    ) {
      const fixture = titleReadFixture.current;
      const [scope] = args;
      const result = await actual.readSessionTitleFieldsFromTranscriptAsync(...args);
      if (
        !fixture ||
        scope.agentId !== "main" ||
        scope.sessionKey !== fixture.key ||
        scope.storePath !== fixture.storePath
      ) {
        return result;
      }
      if (scope.sessionId !== (await fixture.identity.promise)) {
        return result;
      }
      fixture.entered.resolve(undefined);
      await fixture.release.promise;
      return result;
    },
  };
});

vi.mock("../dashboard-session-title.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../dashboard-session-title.js")>();
  return {
    ...actual,
    maybeGenerateDashboardSessionTitle(
      ...args: Parameters<typeof actual.maybeGenerateDashboardSessionTitle>
    ) {
      const task = actual.maybeGenerateDashboardSessionTitle(...args);
      const fixture = titleReadFixture.current;
      if (
        fixture &&
        args[0].agentId === "main" &&
        args[0].sessionKey === fixture.key &&
        args[0].storePath === fixture.storePath
      ) {
        fixture.tasks.push(task);
      }
      return task;
    },
  };
});

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

test.each(["later-read", "delivered-event", "ui-patch", "title-event", "clear-event"])(
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
    const titleDelivered = createDeferred();
    let releasingTitle = false;
    let clearPatched = false;
    const context = createDirectChatContext({
      getRuntimeConfig,
      getSessionEventSubscriberConnIds: () => subscribers,
      broadcastToConnIds: (event, payload) => {
        deliveredEvents.push({ event, payload });
        emitEvent({ type: "event", event, payload });
        if (
          releasingTitle &&
          event === "sessions.changed" &&
          isRecord(payload) &&
          payload.reason === "chat.title"
        ) {
          titleDelivered.resolve(undefined);
        }
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
    const titleFixture: TitleReadFixture | undefined =
      mode === "title-event" || mode === "clear-event"
        ? {
            key,
            storePath,
            identity: createDeferred<string>(),
            entered: createDeferred(),
            release: createDeferred(),
            tasks: [],
          }
        : undefined;
    titleReadFixture.set(titleFixture);
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
        } else if (
          listCalls === 2 &&
          (mode === "delivered-event" || mode === "title-event" || mode === "clear-event")
        ) {
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
      if (
        row() &&
        (mode === "clear-event"
          ? row()?.thinkingLevel === undefined
          : row()?.thinkingLevel === "low")
      ) {
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
      if (titleFixture) {
        const sessionId = created?.entry?.sessionId;
        if (typeof sessionId !== "string" || !sessionId) {
          throw new Error("Title fixture needs the created session identity");
        }
        titleFixture.identity.resolve(sessionId);
        await waitFor(titleFixture.entered.promise, "title reader admission");
      }
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
      if (mode === "clear-event") {
        subscribers.add("created-thinking-proof");
        await successfulSessionRequest(
          "sessions.patch",
          { key, agentId: "main", thinkingLevel: null },
          requestOptions(),
        );
        clearPatched = true;
        await flushPendingSessionsChangedEvents();
        expect(deliveredEvents).toContainEqual({
          event: "sessions.changed",
          payload: expect.objectContaining({ ...identity, thinkingLevel: null }),
        });
        expect(row()).toBeUndefined();
        expect(sessions.think(key, "main")).toBeUndefined();
        expect(runModel).not.toHaveBeenCalled();
        releaseFirstList.resolve(undefined);
        await waitFor(secondListRead.promise, "clear successor list");
        releaseSecondList.resolve(undefined);
        await waitFor(lowListPublished.promise, "canonical default publication");
        expect(row()).toBeDefined();
        expect(row()?.thinkingLevel).toBeUndefined();
        expect(sessions.think(key, "main")).toBeUndefined();
        return;
      }
      if (mode === "delivered-event" || mode === "title-event") {
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
        if (titleFixture) {
          // The independent title task publishes its real settled snapshot after the old row.
          releasingTitle = true;
          titleFixture.release.resolve(undefined);
          await waitFor(titleDelivered.promise, "title settlement publication");
          await waitFor(Promise.all(titleFixture.tasks), "title task settlement");
          expect(runModel).not.toHaveBeenCalled();
          expect(row()).toMatchObject(highEntry);
          expect(sessions.think(key, "main")).toBe("low");
        }
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
      titleFixture?.identity.resolve("");
      titleFixture?.release.resolve(undefined);
      releaseSecondList.resolve(undefined);
      releaseReply.resolve(undefined);
      releaseFirstList.resolve(undefined);
      try {
        await settleWorkspaceRuns(context, storePath, key, true);
        if (clearPatched) {
          await waitFor(lowListPublished.promise, "clear canonical cleanup");
        }
        if ((mode === "delivered-event" || mode === "title-event") && listCalls >= 2) {
          await waitFor(lowListPublished.promise, "successor cleanup");
        }
      } finally {
        try {
          if (titleFixture) {
            await waitFor(Promise.all(titleFixture.tasks), "title task cleanup");
            await flushPendingSessionsChangedEvents();
          }
        } finally {
          titleReadFixture.set(undefined);
          unsubscribe();
          sessions.dispose();
          requests.mockRestore();
          gatewayReplyMock.mockReset();
          runModel.mockRestore();
          clock.mockRestore();
        }
      }
    }
  },
);
