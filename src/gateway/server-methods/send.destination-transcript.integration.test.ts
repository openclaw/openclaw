import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { jsonResult } from "../../agents/tools/common.js";
import type { ChannelPlugin } from "../../channels/plugins/types.public.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import {
  createSessionEntryWithTranscript,
  loadTranscriptEvents,
} from "../../config/sessions/session-accessor.js";
import { readTranscriptEventMessage } from "../../config/sessions/session-accessor.sqlite-read.js";
import { readSessionEntryReadOnlyInWorker } from "../../config/sessions/session-entry-read-runtime.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  mintAgentRuntimeIdentityToken,
  verifyAgentRuntimeIdentityToken,
} from "../agent-runtime-identity-token.js";
import { sendHandlers } from "./send.js";
import {
  createMessageActionTurnClientForTests,
  directCliClientForTests,
} from "./send.test-helpers.js";
import { createMessageMethodTestDriver, makeContext } from "./send.test-support.js";

const baseKey = "agent:main:transcript-test:group:destination";
const runKey = "agent:main:transcript-test:group:source";
const location = { latitude: 48.858844, longitude: 2.294351, accuracy: 12 };
const mediaUrls = ["https://example.test/first.pdf", "https://example.test/second.pdf"];
const cases: {
  name: string;
  params: Record<string, unknown>;
  text: string;
  core?: boolean;
  split?: "destination" | "source";
  confirmedThread?: string;
}[] = [
  ...([false, true] as const).flatMap((core) =>
    (["destination", "source"] as const).map((split) => ({
      name: `${core ? "core" : "plugin"} split-session ${split}`,
      params: { message: "Split-session result" },
      text: "Split-session result",
      core,
      split,
    })),
  ),
  { name: "text", params: { message: "A visible result" }, text: "A visible result" },
  { name: "core text", params: { message: "Core result" }, text: "Core result", core: true },
  {
    name: "all media references",
    params: { message: "Documents", mediaUrls },
    text: "Documents\nfirst.pdf, second.pdf",
  },
  { name: "location", params: { location }, text: "📍 48.858844, 2.294351 ±12m" },
  {
    name: "receipt-confirmed thread",
    params: { message: "A threaded result" },
    text: "A threaded result",
    confirmedThread: "42",
  },
];

afterEach(() => resetPluginRuntimeStateForTest());

describe("Gateway sends preserve caller scopes and own destination persistence", () => {
  it.each(cases)("persists $name exactly once after replay", async (scenario) => {
    await withOpenClawTestState({ prefix: "gateway-destination-transcript-" }, async (state) => {
      const accepted: Record<string, unknown>[] = [];
      const receivedScopes: (readonly string[] | undefined)[] = [];
      const scopes = ["operator.write"];
      const split = scenario.split;
      const to = split === "source" ? "source" : "-1001234567890";
      // Fake only platform acceptance; routing and SQLite persistence stay real.
      const storePath = path.join(state.agentDir(), "openclaw-agent.sqlite");
      const cfg: OpenClawConfig = {
        agents: { defaults: { workspace: state.workspaceDir } },
        session: { store: storePath },
        channels: { "transcript-test": { enabled: true } },
      };
      await state.writeConfig(cfg);
      setRuntimeConfigSnapshot(cfg, cfg);
      const plugin: ChannelPlugin = {
        ...createChannelTestPluginBase({
          id: "transcript-test",
          capabilities: { chatTypes: ["group"] },
        }),
        outbound: {
          deliveryMode: "direct",
          sendText: async ({ text, gatewayClientScopes, sessionKey }) => {
            if (split) {
              expect(sessionKey).toBe(baseKey);
            }
            expect(scenario.core).toBe(true);
            accepted.push({ message: text });
            receivedScopes.push(gatewayClientScopes);
            return { channel: "transcript-test", messageId: "core-message" };
          },
        },
        actions: scenario.core
          ? undefined
          : {
              describeMessageTool: () => ({ actions: ["send"] }),
              supportsAction: ({ action }) => action === "send",
              handleAction: async ({ params, gatewayClientScopes, sessionKey }) => {
                if (split) {
                  expect(sessionKey).toBe(baseKey);
                }
                receivedScopes.push(gatewayClientScopes);
                accepted.push(params);
                return jsonResult({
                  ok: true,
                  result: {
                    messageId: "platform-" + accepted.length,
                    receipt: { threadId: scenario.confirmedThread },
                  },
                });
              },
            },
        messaging: {
          targetResolver: { looksLikeId: () => true },
          resolveOutboundSessionRoute: ({ threadId }) => ({
            sessionKey:
              split === "source"
                ? runKey
                : threadId == null
                  ? baseKey
                  : baseKey + ":topic:" + threadId,
            baseSessionKey: split === "source" ? runKey : baseKey,
            recipientSessionExact: true,
            peer: { kind: "group", id: to },
            chatType: "group",
            from: "transcript-test:group:-1001234567890",
            to,
            ...(threadId == null ? {} : { threadId }),
          }),
        },
      };
      setActivePluginRegistry(
        createTestRegistry([{ pluginId: "transcript-test", source: "test", plugin }]),
      );
      const context = makeContext(() => cfg);
      const { runMessageActionRequest } = createMessageMethodTestDriver(() => sendHandlers);
      const turn = split
        ? createMessageActionTurnClientForTests({ sessionKey: baseKey, runId: "split-session-run" })
        : undefined;
      try {
        let client: Parameters<typeof runMessageActionRequest>[1] = {
          connect: { ...directCliClientForTests().connect, scopes },
        };
        if (turn) {
          expect(
            await createSessionEntryWithTranscript(
              { agentId: "main", sessionKey: runKey, storePath },
              () => ({ ok: true, entry: { sessionId: "producing-run-session", updatedAt: 1 } }),
            ),
          ).toMatchObject({ ok: true });
          const identity = turn.client.internal.agentRuntimeIdentity;
          const token = await mintAgentRuntimeIdentityToken({
            agentId: identity.agentId,
            sessionKey: identity.sessionKey,
            operationalRunInstance: identity.operationalRunInstance,
            messageActionContext: {
              ...identity.messageActionContext,
              sourceReplySessionKey: runKey,
              sourceReplyFinal: true,
              sourceReplyToolCallId: "split-session-call",
              toolContext: {
                currentChannelProvider: "transcript-test",
                currentChannelId: to,
                currentChatType: "group",
                currentSourceTurnId: "split-session-turn",
              },
            },
          });
          const verified = await verifyAgentRuntimeIdentityToken(token);
          if (!verified?.messageActionContext) {
            throw new Error("Signed runtime identity was not verified");
          }
          client = {
            ...turn.client,
            internal: {
              agentRuntimeIdentity: {
                ...verified,
                messageActionContext: verified.messageActionContext,
              },
            },
          };
          context.validateAgentRuntimeApprovalAuthority =
            turn.context.validateAgentRuntimeApprovalAuthority;
        }
        const send = async (params: Record<string, unknown>, idempotencyKey: string) => {
          const { respond } = await runMessageActionRequest(
            {
              channel: "transcript-test",
              action: "send",
              params: { to, ...params },
              ...(split ? { sessionKey: baseKey, agentId: "main" } : {}),
              idempotencyKey,
            },
            client,
            context,
          );
          expect(respond).toHaveBeenCalledOnce();
          expect(respond.mock.calls[0]?.slice(0, 3)).toEqual([
            true,
            expect.objectContaining(scenario.core ? { deliveryStatus: "sent" } : { ok: true }),
            undefined,
          ]);
        };
        const history = async (sessionKey: string) => {
          const scope = { agentId: "main", sessionKey, storePath };
          const entry = await readSessionEntryReadOnlyInWorker(scope);
          return entry
            ? (await loadTranscriptEvents({ ...scope, sessionId: entry.sessionId }))
                .map(readTranscriptEventMessage)
                .filter((message) => message !== undefined)
            : [];
        };
        const destination =
          split === "source" ? runKey : scenario.confirmedThread ? baseKey + ":topic:42" : baseKey;
        await send(scenario.params, "first-delivery");
        await send(scenario.params, "first-delivery");
        expect(accepted).toHaveLength(1);
        // Undefined means trusted internal writeback to transports such as Telegram.
        expect(receivedScopes).toEqual([scopes]);
        const first = await history(destination);
        expect.soft(first).toHaveLength(1);
        expect.soft(first[0]).toMatchObject({
          role: "assistant",
          content: [{ type: "text", text: scenario.text }],
        });
        if (split) {
          const source = await history(runKey);
          expect(source).toHaveLength(1);
          expect(source[0]).toMatchObject({
            role: "assistant",
            content: [{ type: "text", text: scenario.text }],
            openclawDeliveryMirror: { kind: "message-tool-source-reply", final: true },
          });
          if (split === "source") {
            expect(await history(baseKey)).toEqual([]);
          }
        }
        if (scenario.confirmedThread) {
          expect.soft(await history(baseKey)).toEqual([]);
        }
      } finally {
        turn?.close();
      }
    });
  });
});
