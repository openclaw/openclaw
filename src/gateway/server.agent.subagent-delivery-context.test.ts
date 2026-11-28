import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, test } from "vitest";
import { createDeferred, withinTest } from "../../test/helpers/promise.js";
import { killSubagentRunAdmin } from "../agents/subagents/registry/subagent-control.js";
import type { SubagentAdminKillResult } from "../agents/subagents/registry/subagent-control.types.js";
import { registerSubagentRun } from "../agents/subagents/registry/subagent-registry.js";
import { getRuntimeConfig } from "../config/config.js";
import { loadSessionEntry } from "../config/sessions/session-accessor.js";
import type { SessionEntry } from "../config/sessions/types.js";
import {
  createChannelTestPluginBase,
  createDirectOutboundTestAdapter,
} from "../test-utils/channel-plugins.js";
import { projectSessionDeliveryFields } from "../utils/delivery-context.shared.js";
import { setRegistry } from "./server.agent.gateway-server-agent.mocks.js";
import { createRegistry } from "./server.e2e-registry-helpers.js";
import { installConnectedSessionStoreGatewaySuite } from "./test-helpers.connected-session-store.js";
import {
  agentCommandMock,
  installGatewayTestHooks,
  onceMessage,
  prepareGatewayReplyRuntimeForTest,
  rpcReq,
  testState,
  writeSessionStore,
} from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

const gatewaySuite = installConnectedSessionStoreGatewaySuite("openclaw-gw-subagent-delivery-ctx-");
const childKey = "agent:main:subagent:pre-patched";
const childDelivery = {
  channel: "slack",
  to: "user:U07FDR83W6N",
  accountId: "default",
  threadId: "1775577152.364109",
};

const defaultRegistry = createRegistry([
  {
    pluginId: "slack",
    source: "test",
    plugin: {
      ...createChannelTestPluginBase({ id: "slack", label: "Slack" }),
      outbound: createDirectOutboundTestAdapter({
        channel: "slack",
        resolveTarget: ({ to }) =>
          to?.trim()
            ? { ok: true, to: to.trim() }
            : { ok: false, error: new Error("missing target for slack") },
      }),
    },
  },
]);

type StoredEntry = SessionEntry & ReturnType<typeof projectSessionDeliveryFields>;

type StoreEntries = Parameters<typeof writeSessionStore>[0]["entries"];

async function prepareSessionStore(entries: StoreEntries = {}): Promise<void> {
  setRegistry(defaultRegistry);
  testState.sessionStorePath = gatewaySuite.sessionStorePath;
  await writeSessionStore({ entries });
}

async function readStoredSessionEntry(key: string): Promise<StoredEntry> {
  const entry = loadSessionEntry({ sessionKey: key, storePath: gatewaySuite.sessionStorePath });
  assert(entry, `expected stored entry ${key}`);
  return { ...entry, ...projectSessionDeliveryFields(entry.delivery) };
}

const finalResponse = (id: string) =>
  onceMessage(
    gatewaySuite.ws,
    (frame) => frame.type === "res" && frame.id === id && frame.payload?.status !== "accepted",
  );

async function sendAgentRequest(params: Record<string, unknown>): Promise<void> {
  await prepareGatewayReplyRuntimeForTest();
  const id = randomUUID();
  // Acceptance precedes execution; the next fixture must not delete a session with an active run.
  const final = finalResponse(id);
  gatewaySuite.ws.send(
    JSON.stringify({ type: "req", id, method: "agent", params: { deliver: false, ...params } }),
  );
  expect(await final).toMatchObject({ ok: true, payload: { status: "ok" } });
}

test("existing session route metadata survives agent request delivery normalization", async () => {
  const key = "agent:main:subagent:existing-route-metadata";
  const deliveryContext = {
    channel: "slack",
    to: "channel:C0AF8TW48UQ",
    accountId: "default",
    threadId: "1771242986.529939",
  };
  const route = {
    channel: "slack",
    accountId: "default",
    target: { to: "channel:C0AF8TW48UQ", rawTo: "slack://C0AF8TW48UQ", chatType: "channel" },
    thread: { id: "1771242986.529939", kind: "thread", source: "target" },
  } satisfies NonNullable<StoredEntry["route"]>;
  await prepareSessionStore({
    [key]: {
      sessionId: "sess-existing-route",
      updatedAt: Date.now(),
      route: structuredClone(route),
      deliveryContext,
    },
  });

  await sendAgentRequest({
    message: "follow-up",
    sessionKey: key,
    ...deliveryContext,
    idempotencyKey: "idem-subagent-delivery-route-metadata",
  });

  expect((await readStoredSessionEntry(key)).route).toEqual(route);
});

test.for(["completed", "self-stopped"] as const)(
  "pre-created subagent session inherits deliveryContext from agent request (%s)",
  async (ending, { signal }) => {
    // Spawn persists lineage first; the agent request must fill the missing delivery context.
    await prepareSessionStore({
      [childKey]: {
        sessionId: "sess-pre-patched",
        lifecycleRevision: "pre-patched-revision",
        updatedAt: Date.now(),
        spawnDepth: 1,
        spawnedBy: "agent:main:slack:direct:u07fdr83w6n:thread:1775577152.364109",
      },
    });

    const runId = `idem-subagent-delivery-ctx-prepatched-${ending}`;
    const request = {
      message: "[Subagent Task]: investigate data",
      sessionKey: childKey,
      ...childDelivery,
      idempotencyKey: runId,
    };
    if (ending === "self-stopped") {
      await registerSubagentRun({
        runId,
        childSessionKey: childKey,
        childAgentId: "main",
        sessionEntry: await readStoredSessionEntry(request.sessionKey),
        requesterSessionKey: "agent:main:slack:direct:u07fdr83w6n:thread:1775577152.364109",
        requesterAgentId: "main",
        requesterDisplayKey: "main",
        task: "Stop this child from its own running command",
        cleanup: "keep",
        expectsCompletionMessage: false,
      });
      const stopped = createDeferred<SubagentAdminKillResult>();
      const releaseCommand = createDeferred();
      agentCommandMock.mockImplementationOnce(async (options) => {
        const abortSignal = asOptionalRecord(options)?.abortSignal;
        assert(
          abortSignal instanceof AbortSignal,
          "Expected the admitted child cancellation signal",
        );
        try {
          stopped.resolve(
            await killSubagentRunAdmin({
              cfg: getRuntimeConfig(),
              sessionKey: request.sessionKey,
              expectedRunId: runId,
            }),
          );
          expect(abortSignal.aborted).toBe(true);
          await releaseCommand.promise;
          abortSignal.throwIfAborted();
        } catch (error) {
          stopped.reject(error);
          throw error;
        }
      });
      await prepareGatewayReplyRuntimeForTest();
      try {
        const accepted = await rpcReq(gatewaySuite.ws, "agent", { deliver: false, ...request });
        expect(accepted).toMatchObject({ ok: true, payload: { status: "accepted", runId } });
        const killed = await withinTest(stopped.promise, signal);
        expect(killed).toMatchObject({ found: true, killed: true });
        const final = finalResponse(accepted.id);
        releaseCommand.resolve();
        expect(await final).toMatchObject({ ok: true, payload: { status: "timeout" } });
      } finally {
        releaseCommand.resolve();
      }
    } else {
      await sendAgentRequest(request);
    }

    const entry = await readStoredSessionEntry(childKey);
    expect(entry.deliveryContext).toMatchObject(childDelivery);
    expect(entry.route).toEqual({
      channel: "slack",
      accountId: "default",
      target: { to: "user:U07FDR83W6N" },
      thread: { id: "1775577152.364109" },
    });
    expect(entry.lastThreadId).toBe("1775577152.364109");
  },
);
