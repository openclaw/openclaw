import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  registerNative,
  useNativeProcessFixture,
} from "../../agents/harness/acp-native-process.test-support.js";
import * as replyInitialization from "../../config/sessions/session-accessor.reset.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { listSessionEntries, upsertSessionEntry } from "../../plugin-sdk/session-store-runtime.js";
import { readVisibleSessionTranscriptMessageEntries } from "../../plugin-sdk/session-transcript-runtime.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { coreGatewayHandlers } from "./core-handlers.js";
import type { GatewayClient, RespondFn } from "./types.js";

vi.mock("./chat-send-admission.js", () => ({
  admitChatSend: () => {
    throw new Error("Refused native input must not enter send admission");
  },
}));
useNativeProcessFixture();

function nativeConfig(workspace: string): OpenClawConfig {
  return {
    tools: { profile: "full", deny: ["browser"] },
    agents: {
      defaults: {
        workspace,
        model: { primary: "acp-opencode/selected" },
        models: { "acp-opencode/selected": { agentRuntime: { id: "acp-opencode" } } },
      },
    },
  };
}

function nativeClient(scopes = ["operator.admin"], profileId?: string): GatewayClient {
  return {
    connId: "native-consent-client",
    connect: {
      minProtocol: 1,
      maxProtocol: 1,
      role: "operator",
      scopes,
      client: { id: "openclaw-control-ui", version: "test", platform: "test", mode: "webchat" },
    },
    ...(profileId
      ? {
          authenticatedUserProfile: {
            profileId,
            displayName: null,
            hasAvatar: false,
            updatedAt: 1,
          },
        }
      : {}),
  };
}

it.each([false, true])(
  "refuses native chat.send before input persistence with an existing session=%s",
  async (preseed) => {
    await withOpenClawTestState({ label: "chat-native-consent" }, async (state) => {
      const config = nativeConfig(state.workspaceDir);
      await state.writeConfig(config);
      const native = await registerNative(state, config, "owner-agent.mjs");
      const target = {
        agentId: "main",
        sessionKey: "agent:main:dashboard:native-consent",
        sessionId: "native-consent-session",
      };
      if (preseed) {
        await upsertSessionEntry({
          ...target,
          entry: {
            sessionId: target.sessionId,
            updatedAt: Date.now(),
            providerOverride: "acp-opencode",
            modelOverride: "selected",
            modelOverrideSource: "user",
            agentRuntimeOverride: "acp-opencode",
            permissionMode: "full",
            sandboxMode: "off",
          },
        });
      }
      const respond = vi.fn<RespondFn>();
      const context = createDirectChatContext({ getRuntimeConfig: () => config });
      const client = nativeClient();
      try {
        await expectDefined(
          coreGatewayHandlers["chat.send"],
          "registered chat.send",
        )({
          req: { type: "req", id: "native-consent-request", method: "chat.send" },
          params: {
            sessionKey: target.sessionKey,
            agentId: target.agentId,
            message: "Keep this input unsent until I choose native permissions.",
            idempotencyKey: "native-consent-run",
          },
          respond,
          context,
          client,
          isWebchatConnect: () => false,
        });
        expect(respond).toHaveBeenCalledWith(
          false,
          undefined,
          expect.objectContaining({
            details: expect.objectContaining({
              code: "AGENT_RUNTIME_RESTRICTED",
              reason: "tool-policy",
              runtimeId: "acp-opencode",
            }),
          }),
        );
        const persisted = expectDefined(
          listSessionEntries({ agentId: target.agentId, readOnly: true }).find(
            (row) => row.sessionKey === target.sessionKey,
          )?.entry,
          "real consent-bound session",
        );
        expect(respond.mock.calls[0]?.[2]?.details).toMatchObject({
          recovery: { sessionId: persisted.sessionId },
        });
        expect(
          await readVisibleSessionTranscriptMessageEntries({
            ...target,
            sessionId: persisted.sessionId,
          }),
        ).toEqual([]);
        expect(persisted.nativeRuntimeConsent).toBeUndefined();
        if (!preseed) {
          expect(persisted.lifecycleRevision).toBeTypeOf("string");
          expect(persisted.providerOverride).toBeUndefined();
          expect(persisted.modelOverride).toBeUndefined();
          expect(persisted.agentRuntimeOverride).toBeUndefined();
        }
        expect(context.chatAbortControllers.size).toBe(0);
      } finally {
        await native.service.stop?.(native.context);
      }
    });
  },
);

it.each([
  { kind: "non-admin", reason: "tool-policy" },
  { kind: "creator sandbox", reason: "sandbox-required" },
  { kind: "execution sandbox", reason: "sandbox-required" },
  { kind: "remote execution", reason: "remote-execution" },
] as const)(
  "refuses a new $kind target without creating a consent row",
  async ({ kind, reason }) => {
    await withOpenClawTestState({ label: "chat-native-mandatory" }, async (state) => {
      const config = nativeConfig(state.workspaceDir);
      const profile = ensureProfileForEmail("native-creator@example.test");
      const client = nativeClient(
        kind === "non-admin" ? ["operator.write"] : undefined,
        profile.id,
      );
      if (kind === "creator sandbox") {
        config.gateway = {
          roles: {
            default: "restricted",
            definitions: {
              restricted: {
                agents: "*",
                scopes: ["operator.admin"],
                sessions: { others: "write" },
                sandbox: "required",
              },
            },
          },
        };
      } else if (kind === "execution sandbox" || kind === "remote execution") {
        config.tools = {
          ...config.tools,
          exec: { host: kind === "execution sandbox" ? "sandbox" : "node" },
        };
      }
      await state.writeConfig(config);
      const native = await registerNative(state, config, "owner-agent.mjs");
      const respond = vi.fn<RespondFn>();
      const context = createDirectChatContext({ getRuntimeConfig: () => config });
      const sessionKey = "agent:main:main";
      try {
        await expectDefined(
          coreGatewayHandlers["chat.send"],
          "registered chat.send",
        )({
          req: { type: "req", id: "restricted-first-send", method: "chat.send" },
          params: {
            sessionKey,
            agentId: "main",
            message: "This message must remain unsent.",
            idempotencyKey: "restricted-native-run",
          },
          respond,
          context,
          client,
          isWebchatConnect: () => true,
        });
        expect(respond).toHaveBeenCalledWith(
          false,
          undefined,
          expect.objectContaining({
            details: expect.objectContaining({ code: "AGENT_RUNTIME_RESTRICTED", reason }),
          }),
        );
        expect(respond.mock.calls[0]?.[2]?.details).not.toHaveProperty("recovery");
        expect(listSessionEntries({ agentId: "main", readOnly: true })).toEqual([]);
        expect(context.chatAbortControllers.size).toBe(0);
      } finally {
        await native.service.stop?.(native.context);
      }
    });
  },
);

it.each(["authority", "mandatory policy", "competing entry"] as const)(
  "rechecks $change before committing first-send consent identity",
  async (change) => {
    await withOpenClawTestState({ label: "chat-native-creation-race" }, async (state) => {
      const config = nativeConfig(state.workspaceDir);
      await state.writeConfig(config);
      const native = await registerNative(state, config, "owner-agent.mjs");
      const client = nativeClient();
      const respond = vi.fn<RespondFn>();
      const context = createDirectChatContext({ getRuntimeConfig: () => config });
      const sessionKey = "agent:main:main";
      const entered = createDeferred();
      const release = createDeferred();
      const commit = replyInitialization.commitReplySessionInitialization;
      vi.spyOn(replyInitialization, "commitReplySessionInitialization").mockImplementation(
        async (params) => {
          entered.resolve();
          await release.promise;
          return commit(params);
        },
      );
      const sending = Promise.resolve(
        expectDefined(
          coreGatewayHandlers["chat.send"],
          "registered chat.send",
        )({
          req: { type: "req", id: "racing-first-send", method: "chat.send" },
          params: {
            sessionKey,
            agentId: "main",
            message: "Do not commit stale consent or input.",
            idempotencyKey: "racing-native-run",
          },
          respond,
          context,
          client,
          isWebchatConnect: () => true,
        }),
      );
      const outcome = sending.then(
        () => undefined,
        (error: unknown) => error,
      );
      try {
        await entered.promise;
        if (change === "authority") {
          client.connect.scopes = ["operator.write"];
        } else if (change === "mandatory policy") {
          config.tools = { ...config.tools, exec: { host: "sandbox" } };
        } else {
          await upsertSessionEntry({
            agentId: "main",
            sessionKey,
            entry: { sessionId: "competing-session", updatedAt: 1, label: "Keep competing entry" },
          });
        }
        release.resolve();
        await outcome;
        const entries = listSessionEntries({ agentId: "main", readOnly: true });
        if (change === "competing entry") {
          expect(entries).toMatchObject([
            {
              sessionKey,
              entry: { sessionId: "competing-session", label: "Keep competing entry" },
            },
          ]);
        } else {
          expect(entries).toEqual([]);
        }
        expect(entries.every(({ entry }) => entry.nativeRuntimeConsent === undefined)).toBe(true);
        expect(context.chatAbortControllers.size).toBe(0);
      } finally {
        release.resolve();
        await outcome;
        await native.service.stop?.(native.context);
      }
    });
  },
);
