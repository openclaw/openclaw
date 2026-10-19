// Subagent delivery-context tests protect route metadata inheritance for child
// agent sessions and outbound delivery through channel plugins.
import { randomUUID } from "node:crypto";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { describe, expect, test } from "vitest";
import { createDeferred, withinTest } from "../../test/helpers/promise.js";
import { killSubagentRunAdmin } from "../agents/subagents/registry/subagent-control.js";
import type { SubagentAdminKillResult } from "../agents/subagents/registry/subagent-control.types.js";
import { registerSubagentRun } from "../agents/subagents/registry/subagent-registry.js";
import type { ChannelPlugin } from "../channels/plugins/types.public.js";
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

const createStubChannelPlugin = (params: {
  id: ChannelPlugin["id"];
  label: string;
}): ChannelPlugin => ({
  ...createChannelTestPluginBase({
    id: params.id,
    label: params.label,
  }),
  outbound: createDirectOutboundTestAdapter({
    channel: params.id,
    resolveTarget: ({ to }) => {
      const trimmed = to?.trim() ?? "";
      if (trimmed) {
        return { ok: true, to: trimmed };
      }
      return { ok: false, error: new Error(`missing target for ${params.id}`) };
    },
  }),
});

const defaultRegistry = createRegistry([
  {
    pluginId: "slack",
    source: "test",
    plugin: createStubChannelPlugin({ id: "slack", label: "Slack" }),
  },
]);

type StoredEntry = SessionEntry & ReturnType<typeof projectSessionDeliveryFields>;

type StoreEntries = Parameters<typeof writeSessionStore>[0]["entries"];

async function prepareSessionStore(entries: StoreEntries = {}): Promise<void> {
  setRegistry(defaultRegistry);
  testState.sessionStorePath = gatewaySuite.sessionStorePath;
  await writeSessionStore({ entries });
}

function readDeliveryContext(entry: StoredEntry): NonNullable<StoredEntry["deliveryContext"]> {
  if (!entry.deliveryContext) {
    throw new Error("expected stored deliveryContext");
  }
  return entry.deliveryContext;
}

async function readStoredSessionEntry(key: string): Promise<StoredEntry> {
  const entry = loadSessionEntry({ sessionKey: key, storePath: gatewaySuite.sessionStorePath }) as
    | StoredEntry
    | undefined;
  if (!entry) {
    throw new Error(`expected stored entry ${key}`);
  }
  return { ...entry, ...projectSessionDeliveryFields(entry.delivery) };
}

async function sendAgentRequest(params: Record<string, unknown>): Promise<void> {
  await prepareGatewayReplyRuntimeForTest();
  const id = randomUUID();
  // Acceptance precedes execution; the next fixture must not delete a session with an active run.
  const finalResponse = onceMessage(
    gatewaySuite.ws,
    (message) =>
      message.type === "res" && message.id === id && message.payload?.status !== "accepted",
  );
  gatewaySuite.ws.send(
    JSON.stringify({ type: "req", id, method: "agent", params: { deliver: false, ...params } }),
  );
  const res = await finalResponse;
  expect(res.ok).toBe(true);
  expect(res.payload?.status).toBe("ok");
}

function expectDeliveryContextFields(entry: StoredEntry, expected: Record<string, unknown>): void {
  const deliveryContext = readDeliveryContext(entry);
  for (const [key, value] of Object.entries(expected)) {
    expect(deliveryContext[key as keyof typeof deliveryContext]).toBe(value);
  }
}

describe("subagent session deliveryContext from spawn request params", () => {
  test("existing session route metadata survives agent request delivery normalization", async () => {
    await prepareSessionStore({
      "agent:main:subagent:existing-route-metadata": {
        sessionId: "sess-existing-route",
        updatedAt: Date.now(),
        route: {
          channel: "slack",
          accountId: "default",
          target: {
            to: "channel:C0AF8TW48UQ",
            rawTo: "slack://C0AF8TW48UQ",
            chatType: "channel",
          },
          thread: {
            id: "1771242986.529939",
            kind: "thread",
            source: "target",
          },
        },
        deliveryContext: {
          channel: "slack",
          to: "channel:C0AF8TW48UQ",
          accountId: "default",
          threadId: "1771242986.529939",
        },
        lastChannel: "slack",
        lastTo: "channel:C0AF8TW48UQ",
        lastAccountId: "default",
        lastThreadId: "1771242986.529939",
      },
    });

    await sendAgentRequest({
      message: "follow-up",
      sessionKey: "agent:main:subagent:existing-route-metadata",
      channel: "slack",
      to: "channel:C0AF8TW48UQ",
      accountId: "default",
      threadId: "1771242986.529939",
      idempotencyKey: "idem-subagent-delivery-route-metadata",
    });

    const entry = await readStoredSessionEntry("agent:main:subagent:existing-route-metadata");
    expect(entry.route).toEqual({
      channel: "slack",
      accountId: "default",
      target: {
        to: "channel:C0AF8TW48UQ",
        rawTo: "slack://C0AF8TW48UQ",
        chatType: "channel",
      },
      thread: {
        id: "1771242986.529939",
        kind: "thread",
        source: "target",
      },
    });
  });

  test.for(["completed", "self-stopped"] as const)(
    "pre-created subagent session inherits deliveryContext from agent request (%s)",
    async (ending, { signal }) => {
      // Simulates the real subagent spawn flow: the trusted session accessor persists lineage
      // before callSubagentGateway({method: "agent"}) seeds the delivery context.
      // The direct lineage write creates a partial entry without deliveryContext.
      // The agent handler must seed deliveryContext from the request params.
      await prepareSessionStore({
        "agent:main:subagent:pre-patched": {
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
        sessionKey: "agent:main:subagent:pre-patched",
        channel: "slack",
        to: "user:U07FDR83W6N",
        accountId: "default",
        threadId: "1775577152.364109",
        idempotencyKey: runId,
      };
      if (ending === "self-stopped") {
        await registerSubagentRun({
          runId,
          childSessionKey: "agent:main:subagent:pre-patched",
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
          if (!(abortSignal instanceof AbortSignal)) {
            throw new Error("Expected the admitted child command's cancellation signal");
          }
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
          expect(accepted.ok).toBe(true);
          expect(accepted.payload).toMatchObject({ status: "accepted", runId });
          expect(await withinTest(stopped.promise, signal)).toMatchObject({
            found: true,
            killed: true,
          });
          const final = onceMessage(
            gatewaySuite.ws,
            (frame) =>
              frame.type === "res" &&
              frame.id === accepted.id &&
              frame.payload?.status !== "accepted",
          );
          releaseCommand.resolve();
          expect(await final).toMatchObject({ ok: true, payload: { status: "timeout" } });
        } finally {
          releaseCommand.resolve();
        }
      } else {
        await sendAgentRequest(request);
      }

      const entry = await readStoredSessionEntry("agent:main:subagent:pre-patched");
      expectDeliveryContextFields(entry, {
        channel: "slack",
        to: "user:U07FDR83W6N",
        threadId: "1775577152.364109",
        accountId: "default",
      });
      expect(entry.route).toEqual({
        channel: "slack",
        accountId: "default",
        target: { to: "user:U07FDR83W6N" },
        thread: { id: "1775577152.364109" },
      });
      expect(entry.lastThreadId).toBe("1775577152.364109");
    },
  );
});
