import { expect, it, vi } from "vitest";
import { buildAllowedModelSet } from "../../agents/model-selection-shared.js";
import { materializeModelPolicyAllowlist } from "../../config/model-policy-allowlist-migration.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { replaceSessionEntrySync } from "../../config/sessions/session-accessor.sqlite-entry.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { normalizeChatSendRequest } from "./chat-send-request.js";
import {
  prepareChatSendSession,
  qualifyChatSendSession,
  withCurrentChatSendSession,
} from "./chat-send-session.js";

it.each([
  "migration",
  "default revocation",
  "agent revocation",
  "empty default allow",
  "empty agent allow",
  "remove empty agent allow",
  "add agent alias policy",
  "remove agent alias policy",
] as const)("retains effective model policy through chat admission (%s)", async (change) => {
  await withOpenClawTestState({ label: "chat-model-policy" }, async () => {
    const aliasChange =
      change === "add agent alias policy" || change === "remove agent alias policy";
    const unrestricted =
      change === "empty default allow" ||
      change === "empty agent allow" ||
      change === "remove empty agent allow";
    const cfg: OpenClawConfig = {
      agents: {
        ownership: "explicit",
        entries: {
          main: {
            ...(aliasChange ? { models: { "fixture/other": { alias: "approved" } } } : {}),
            ...(change === "remove agent alias policy"
              ? { modelPolicy: { allow: ["approved"] } }
              : {}),
            ...(change === "remove empty agent allow" ? { modelPolicy: { allow: [] } } : {}),
          },
        },
        defaults: {
          model: { primary: "fixture/model" },
          models: { "fixture/model": { alias: "approved" } },
          ...(aliasChange ? { modelPolicy: { allow: ["approved"] } } : {}),
          ...(unrestricted ? { modelPolicy: {} } : {}),
        },
      },
    };
    let current = cfg;
    setRuntimeConfigSnapshot(cfg, cfg);
    // Keep selected model identity stable so owner-scope changes cannot be caught
    // accidentally by a changed selected model or provider projection.
    const model = change === "remove agent alias policy" ? "other" : "model";
    const selected = { provider: "fixture", model };
    const allowed = (config: OpenClawConfig) =>
      buildAllowedModelSet({
        cfg: config,
        agentId: "main",
        defaultProvider: "fixture",
        catalog: [
          { provider: "fixture", id: "model", name: "Model" },
          { provider: "fixture", id: "other", name: "Other" },
        ],
      });
    expect(allowed(cfg).allows(selected)).toBe(true);
    expect(allowed(cfg).allowAny).toBe(unrestricted);
    const sessionKey = "agent:main:model-policy";
    replaceSessionEntrySync(
      { agentId: "main", sessionKey },
      {
        sessionId: "model-policy",
        updatedAt: 1,
        providerOverride: "fixture",
        modelOverride: model,
        modelOverrideSource: "user",
      },
    );
    const request = await normalizeChatSendRequest({
      client: null,
      params: { sessionKey, message: "Hello", idempotencyKey: "model-policy" },
    });
    if (!request.ok) {
      throw new Error(request.error);
    }
    const prepared = await prepareChatSendSession({
      request: request.value,
      client: null,
      context: createDirectChatContext({ getRuntimeConfig: () => current }),
    });
    if (!prepared.ok) {
      throw new Error("Session preparation failed");
    }
    const session = await qualifyChatSendSession(prepared.value);
    current = materializeModelPolicyAllowlist(cfg).config;
    if (change === "default revocation" || change === "empty default allow") {
      current = {
        ...current,
        agents: {
          ...current.agents,
          defaults: {
            ...current.agents?.defaults,
            modelPolicy: { allow: change === "default revocation" ? ["fixture/other"] : [] },
          },
        },
      };
    } else if (change !== "migration") {
      const entry = { ...current.agents?.entries?.main };
      if (change === "remove agent alias policy" || change === "remove empty agent allow") {
        delete entry.modelPolicy;
      } else {
        entry.modelPolicy = {
          allow:
            change === "agent revocation"
              ? ["fixture/other"]
              : change === "add agent alias policy"
                ? ["approved"]
                : [],
        };
      }
      current = { ...current, agents: { ...current.agents, entries: { main: entry } } };
    }
    const equivalent = change === "migration" || unrestricted;
    expect(allowed(current).allows(selected)).toBe(equivalent);
    expect(allowed(current).allowAny).toBe(unrestricted);
    const consume = vi.fn(() => "admitted");
    const admission = withCurrentChatSendSession({
      session,
      getRuntimeConfig: () => current,
      includeMembership: false,
      consume,
    });
    if (equivalent) {
      await expect(admission).resolves.toBe("admitted");
      expect(consume).toHaveBeenCalledOnce();
    } else {
      await expect(admission).rejects.toThrow("Session preparation changed; retry.");
      expect(consume).not.toHaveBeenCalled();
    }
  });
});
