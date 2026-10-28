import { assert, expect, it, vi } from "vitest";
import type {
  SessionsCreateResult,
  SessionsRecoverResult,
} from "../../packages/gateway-protocol/src/index.js";
import { runQaGatewayFixture } from "../../test/helpers/qa-gateway-cleanup.js";
import { recoverStore } from "../agents/main-session-recovery/main-session-restart-recovery-store.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import {
  loadSessionEntry,
  loadTranscriptEvents,
  replaceSessionEntry,
} from "../config/sessions/session-accessor.js";
import { readTranscriptEventMessage } from "../config/sessions/session-accessor.sqlite-read.js";
import { appendAssistantMessageToSessionTranscript } from "../config/sessions/transcript.js";
import type { InternalSessionEntry } from "../config/sessions/types.js";
import { resolveStateDir } from "../config/state-dir.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  activateTestChannelRegistry,
  createChannelTestPluginBase,
  createTestRegistry,
} from "../test-utils/channel-plugins.js";
import { deliveryContextFromSession } from "../utils/delivery-context.read.js";
import { normalizeSessionDeliveryState } from "../utils/delivery-context.shared.js";
import { createChatFixture } from "./gateway-chat-fixture.test-support.js";
import { getGatewayRecoveryRuntime } from "./server-recovery-runtime-context.js";
import { projectSessionMessagePayload } from "./session-transcript-message.js";

it("records a confirmed restart notice in its agent history once without another display row", async () => {
  let cfg: OpenClawConfig = {};
  const fixture = createChatFixture("recovery-notice-history", {
    configure(config) {
      cfg = {
        ...config,
        agents: {
          ...config.agents,
          ownership: "explicit",
          entries: { main: {}, secondary: {} },
        },
        plugins: { slots: { memory: "none" } },
      };
      return cfg;
    },
  });
  await runQaGatewayFixture(
    async () => {
      await fixture.start();
      const target = {
        agentId: "secondary",
        sessionKey: "agent:secondary:dashboard:interrupted-recovery",
        storePath: resolveSessionStorePathCore(cfg.session?.store, { agentId: "secondary" }),
      };
      const sendText = vi.fn(
        async (context: {
          text: string;
          onPlatformSendDispatch?: () => Promise<void>;
          assertDirectAdapterHandoff?: () => void;
        }) => {
          await context.onPlatformSendDispatch?.();
          context.assertDirectAdapterHandoff?.();
          return { channel: "recovery-chat", messageId: "notice-message" };
        },
      );
      const plugin = {
        ...createChannelTestPluginBase({
          id: "recovery-chat",
          config: {
            listAccountIds: () => ["work"],
            resolveAccount: () => ({ accountId: "work", enabled: true }),
            isEnabled: () => true,
            isConfigured: () => true,
          },
        }),
        outbound: {
          deliveryMode: "direct" as const,
          resolveTarget: ({ to }: { to?: string }) => ({ ok: true as const, to: to ?? "" }),
          sendText,
        },
      };
      await activateTestChannelRegistry(
        createTestRegistry([{ pluginId: "recovery-chat", source: "test", plugin }]),
      );
      const created = await fixture.client.request<SessionsCreateResult>("sessions.create", {
        agentId: target.agentId,
        key: target.sessionKey,
      });
      expect(created.key).toBe(target.sessionKey);
      assert(created.sessionId, "Expected the public session creation identity");
      await expect(
        fixture.client.request("chat.history", { sessionKey: target.sessionKey }),
      ).resolves.toMatchObject({ sessionId: created.sessionId, messages: [] });
      const entry = loadSessionEntry(target);
      assert(entry, "Expected the published secondary session");
      const scope = { ...target, sessionId: created.sessionId };
      const savedReply = "Unconfirmed private draft from an earlier interrupted reply.";
      expect(
        await appendAssistantMessageToSessionTranscript({
          ...target,
          expectedSessionId: created.sessionId,
          text: `Saved reply (delivery unconfirmed):\n${savedReply}`,
          idempotencyKey: "earlier-saved-reply",
        }),
      ).toMatchObject({ ok: true });
      const delivery = { channel: "recovery-chat", to: "synthetic-recipient", accountId: "work" };
      await replaceSessionEntry(target, {
        ...entry,
        status: "interrupted",
        abortedLastRun: true,
        delivery: normalizeSessionDeliveryState({ context: delivery }),
        mainRestartRecovery: { cycleId: "exhausted-cycle", revision: 1, chargedAttempts: 3 },
      } satisfies InternalSessionEntry);
      expect(deliveryContextFromSession(loadSessionEntry(target))).toEqual(delivery);
      const mainTarget = {
        agentId: "main",
        sessionKey: "agent:main:main",
        storePath: resolveSessionStorePathCore(cfg.session?.store, { agentId: "main" }),
      };
      const mainBefore = loadSessionEntry(mainTarget);
      const runtime = getGatewayRecoveryRuntime();
      assert(runtime, "Expected the started Gateway's recovery owner");
      const sendNotice = vi.spyOn(runtime, "sendRecoveryNotice");
      try {
        const recover = () =>
          recoverStore({
            cfg,
            storeAgentId: target.agentId,
            storePath: target.storePath,
            stateDir: resolveStateDir(process.env),
            handledSessionKeys: new Set(),
            gatewayRuntime: runtime,
          });
        await recover();
        expect(loadSessionEntry(target)?.mainRestartRecovery?.tombstone).toBeDefined();
        expect(sendNotice).toHaveBeenCalledOnce();
        await expect(sendNotice.mock.results[0]?.value).resolves.toEqual({ suppressed: false });
        expect(sendText).toHaveBeenCalledOnce();
        const messages = (await loadTranscriptEvents(scope))
          .map(readTranscriptEventMessage)
          .filter(Boolean);
        const sentText = sendText.mock.calls[0]?.[0].text;
        expect(sentText).toContain("gateway restart");
        expect(messages[1]).toMatchObject({ content: [{ type: "text", text: sentText }] });
        const confirmed = messages.filter((message) => message?.model === "automation-result");
        expect(confirmed).toHaveLength(1);
        expect(confirmed[0]).toMatchObject({ display: false });
        expect(messages.filter((message) => message?.display !== false)).toHaveLength(2);
        for (const historyDelta of [false, true]) {
          expect(
            projectSessionMessagePayload({ ...target, historyDelta, message: messages[1] }).payload,
          ).toBeDefined();
          expect(
            projectSessionMessagePayload({ ...target, historyDelta, message: confirmed[0] })
              .payload,
          ).toBeUndefined();
        }
        await recover();
        expect(sendText).toHaveBeenCalledOnce();
        expect(
          (await loadTranscriptEvents(scope)).map(readTranscriptEventMessage).filter(Boolean),
        ).toEqual(messages);
        expect(loadSessionEntry(mainTarget)).toEqual(mainBefore);
        const visible = await fixture.client.request<{ messages: unknown[] }>("chat.history", {
          sessionKey: target.sessionKey,
        });
        expect(visible.messages).toHaveLength(2);
        expect(JSON.stringify(visible.messages)).toContain(savedReply);
        expect(JSON.stringify(visible.messages).split(sentText!)).toHaveLength(2);
        const resumed = await fixture.client.request<SessionsRecoverResult>("sessions.recover", {
          agentId: target.agentId,
          key: target.sessionKey,
          sessionId: created.sessionId,
          recoveryCycleId: "exhausted-cycle",
          mode: "in-place",
        });
        assert(resumed.continuation.status === "started");
        await expect(
          fixture.client.request("agent.wait", {
            runId: resumed.continuation.runId,
            timeoutMs: 30_000,
          }),
        ).resolves.toMatchObject({ status: "ok" });
        expect(fixture.errors).toEqual([]);
        // Dashboard naming shares this provider; it is separate from the recovered model turn.
        const isTitleRequest = (body: string) => body.includes("Generate a concise session title");
        const turnRequests = fixture.requests.filter((body) => !isTitleRequest(body));
        const requestKinds = fixture.requests.map((body, index) => ({
          purpose: isTitleRequest(body) ? "title" : "turn",
          sessionAffinity: fixture.sessionIds[index],
        }));
        expect(turnRequests, JSON.stringify(requestKinds)).toHaveLength(1);
        const input = JSON.stringify(JSON.parse(turnRequests[0]!).input);
        expect(input.split(sentText!)).toHaveLength(2);
        expect(input).not.toContain(savedReply);
        expect(input).not.toContain(target.storePath);
        expect(input).not.toContain("localNotice");
        expect(loadSessionEntry(mainTarget)).toEqual(mainBefore);
      } finally {
        sendNotice.mockRestore();
      }
    },
    () => fixture.close(),
  );
}, 60_000);
