import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, vi } from "vitest";
import {
  registerNative,
  useNativeProcessFixture,
} from "../../agents/harness/acp-native-process.test-support.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { upsertSessionEntry } from "../../plugin-sdk/session-store-runtime.js";
import { readVisibleSessionTranscriptMessageEntries } from "../../plugin-sdk/session-transcript-runtime.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { chatHandlers } from "./chat.js";
import type { RespondFn } from "./types.js";

useNativeProcessFixture();

it("returns a typed native restriction before chat.send admits or persists the message", async () => {
  await withOpenClawTestState({ label: "chat-native-consent" }, async (state) => {
    const config: OpenClawConfig = {
      tools: { profile: "full", deny: ["browser"] },
      agents: { defaults: { workspace: state.workspaceDir } },
    };
    await state.writeConfig(config);
    const native = await registerNative(state, config, "owner-agent.mjs");
    const target = {
      agentId: "main",
      sessionKey: "agent:main:dashboard:native-consent",
      sessionId: "native-consent-session",
    };
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
    const respond = vi.fn<RespondFn>();
    const context = createDirectChatContext({ getRuntimeConfig: () => config });
    try {
      await expectDefined(
        chatHandlers["chat.send"],
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
        client: null,
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
      expect(await readVisibleSessionTranscriptMessageEntries(target)).toEqual([]);
      expect(context.chatAbortControllers.size).toBe(0);
    } finally {
      await native.service.stop?.(native.context);
    }
  });
});
