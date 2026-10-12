import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  loadSessionEntryReadOnly,
  loadTranscriptEvents,
  replaceSessionEntry,
} from "../config/sessions/session-accessor.js";
import { readTranscriptEventMessage } from "../config/sessions/session-accessor.sqlite-read.js";
import type { OutboundSessionRoute } from "../infra/outbound/outbound-session.js";
import {
  sendDurableMessageBatch,
  withDurableMessageSendContext,
  type DeliveryMirror,
} from "../plugin-sdk/channel-outbound.js";
import {
  captureActivePluginRegistrySnapshot,
  restoreActivePluginRegistrySnapshot,
  setActivePluginRegistry,
} from "../plugins/runtime.js";
import { closeOpenClawAgentDatabasesAsync } from "../state/openclaw-agent-db.js";
import { createOutboundTestPlugin, createTestRegistry } from "../test-utils/channel-plugins.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { commitConfirmedVisibleMessage } from "./confirmed-visible-message.js";
import { beginSessionWorkAdmission } from "./session-lifecycle-admission.js";

const route: OutboundSessionRoute = {
  sessionKey: "agent:main:telegram:group:-100123:topic:42",
  baseSessionKey: "agent:main:telegram:group:-100123",
  recipientSessionExact: true,
  peer: { kind: "group", id: "-100123" },
  chatType: "group",
  from: "telegram:group:-100123:topic:42",
  to: "-100123",
  threadId: 42,
};

describe("confirmed visible message ownership", () => {
  const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
    afterEach(async () => {
      for (const dir of tempDirs.dirs) {
        await closeOpenClawAgentDatabasesAsync(dir);
      }
      cleanup();
    }),
  );

  function setup() {
    const dir = tempDirs.make("openclaw-visible-owner-");
    const storePath = path.join(dir, "agents", "main", "sessions", "sessions.json");
    return {
      storePath,
      params: {
        config: { session: { store: storePath } },
        channel: "telegram" as const,
        to: route.to,
        threadId: route.threadId,
        route,
        payload: { text: "The visible result" },
        deliveryId: "confirmed-send",
        payloadIndex: 0,
      },
    };
  }

  it("creates destination history for an unowned send and deduplicates its replay", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const { params, storePath } = setup();
      const first = await commitConfirmedVisibleMessage(params);
      expect(first).toMatchObject({ ok: true });
      expect(await commitConfirmedVisibleMessage(params)).toEqual(first);
      const entry = loadSessionEntryReadOnly({ sessionKey: route.sessionKey, storePath });
      expect(entry).toBeDefined();
      const events = await loadTranscriptEvents({
        sessionKey: route.sessionKey,
        sessionId: entry!.sessionId,
        storePath,
      });
      const messages = events.map(readTranscriptEventMessage).filter(Boolean);
      expect(messages).toEqual([
        expect.objectContaining({
          role: "assistant",
          provider: "openclaw",
          model: "automation-result",
          content: [{ type: "text", text: "The visible result" }],
        }),
      ]);
    });
  });

  it("keeps legacy SDK mirrors source-compatible without granting another transcript target", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const { params, storePath } = setup();
      const registry = captureActivePluginRegistrySnapshot();
      const warning = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
      const sendText = vi.fn(async () => ({ channel: "telegram", messageId: "sdk-message" }));
      const plugin = {
        ...createOutboundTestPlugin({
          id: "telegram",
          outbound: { deliveryMode: "direct", sendText },
        }),
        messaging: { resolveOutboundSessionRoute: () => route },
      };
      setActivePluginRegistry(
        createTestRegistry([{ pluginId: "telegram", source: "test", plugin }]),
      );
      const otherSessionKey = "agent:main:telegram:group:-100456";
      const mirror: DeliveryMirror = { sessionKey: route.sessionKey };
      const input = {
        cfg: params.config,
        channel: "telegram" as const,
        to: route.to,
        threadId: route.threadId,
        payloads: [params.payload],
        mirror,
      };
      try {
        expect(await sendDurableMessageBatch(input)).toMatchObject({ status: "sent" });
        const entry = loadSessionEntryReadOnly({ sessionKey: route.sessionKey, storePath });
        expect(entry).toBeDefined();
        const readMessages = async () =>
          (
            await loadTranscriptEvents({
              sessionKey: route.sessionKey,
              sessionId: entry!.sessionId,
              storePath,
            })
          )
            .map(readTranscriptEventMessage)
            .filter(Boolean);
        expect(await readMessages()).toEqual([
          expect.objectContaining({
            model: "automation-result",
            content: [{ type: "text", text: params.payload.text }],
          }),
        ]);
        expect(
          await withDurableMessageSendContext(
            { ...input, mirror: { sessionKey: otherSessionKey } },
            async (context) => context.send(await context.render()),
          ),
        ).toMatchObject({ status: "sent" });
        expect(sendText).toHaveBeenCalledTimes(2);
        expect(await readMessages()).toHaveLength(2);
        expect(
          loadSessionEntryReadOnly({ sessionKey: otherSessionKey, storePath }),
        ).toBeUndefined();
        expect(warning).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("mirror"), {
          code: "DEP_PLUGIN_SDK",
          type: "DeprecationWarning",
        });
      } finally {
        warning.mockRestore();
        restoreActivePluginRegistrySnapshot(registry);
      }
    });
  });

  it.each(["key", "context"] as const)(
    "does not wait on or duplicate its active producing conversation by %s",
    async (kind) => {
      await withOpenClawTestState({ scenario: "minimal" }, async () => {
        const { params, storePath } = setup();
        const producerKey = kind === "key" ? route.sessionKey : "agent:main:main";
        await replaceSessionEntry(
          { sessionKey: producerKey, storePath },
          {
            sessionId: "producer",
            updatedAt: 1,
            delivery: {
              kind: "external",
              context: { channel: "telegram", to: route.to, threadId: 42 },
              route: { channel: "telegram", target: { to: route.to }, thread: { id: "42" } },
              origin: { provider: "telegram", to: route.to, threadId: 42 },
            },
          },
        );
        const admission = await beginSessionWorkAdmission({
          scope: storePath,
          identities: [producerKey, "producer"],
          assertAllowed: () => {},
        });
        try {
          expect(
            await commitConfirmedVisibleMessage({
              ...params,
              producer: { key: producerKey, agentId: "main" },
            }),
          ).toEqual({ ok: true, skipped: true });
          expect(
            await loadTranscriptEvents({
              sessionKey: producerKey,
              sessionId: "producer",
              storePath,
            }),
          ).toEqual([]);
        } finally {
          admission.release();
        }
      });
    },
  );

  it("does not confuse two topics of a producing chat", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const { params, storePath } = setup();
      await replaceSessionEntry(
        { sessionKey: "agent:main:main", storePath },
        {
          sessionId: "producer",
          updatedAt: 1,
          delivery: {
            kind: "external",
            context: { channel: "telegram", to: route.to, threadId: 7 },
            route: { channel: "telegram", target: { to: route.to }, thread: { id: "7" } },
            origin: { provider: "telegram", to: route.to, threadId: 7 },
          },
        },
      );
      expect(
        await commitConfirmedVisibleMessage({
          ...params,
          producer: { key: "agent:main:main", agentId: "main" },
        }),
      ).toMatchObject({ ok: true });
      const target = loadSessionEntryReadOnly({ sessionKey: route.sessionKey, storePath });
      expect(target).toBeDefined();
      expect(
        (
          await loadTranscriptEvents({
            sessionKey: route.sessionKey,
            sessionId: target!.sessionId,
            storePath,
          })
        )
          .map(readTranscriptEventMessage)
          .filter(Boolean),
      ).toHaveLength(1);
    });
  });

  it("reports native-only output without inventing conversation text", async () => {
    const { params, storePath } = setup();
    expect(
      await commitConfirmedVisibleMessage({
        ...params,
        payload: { channelData: { discord: { embeds: [{ title: "Native result" }] } } },
      }),
    ).toEqual({
      ok: true,
      skipped: true,
      diagnostics: "native-only payload not added to conversation",
    });
    expect(loadSessionEntryReadOnly({ sessionKey: route.sessionKey, storePath })).toBeUndefined();
  });

  it("warns without writing either agent's history for a cross-agent destination", async () => {
    const { params, storePath } = setup();
    const result = await commitConfirmedVisibleMessage({
      ...params,
      producer: { agentId: "main" },
      config: {
        ...params.config,
        bindings: [{ agentId: "other", match: { channel: "telegram", peer: route.peer } }],
      },
    });
    expect(result).toEqual({
      ok: true,
      skipped: true,
      diagnostics: "Conversation context skipped: the destination belongs to a different agent.",
    });
    expect(loadSessionEntryReadOnly({ sessionKey: route.sessionKey, storePath })).toBeUndefined();
  });
});
