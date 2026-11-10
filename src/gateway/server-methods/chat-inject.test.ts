import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, vi } from "vitest";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import {
  loadSessionEntryReadOnly,
  loadTranscriptEvents,
} from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { completeAgentOnboarding } from "./agents-onboarding.js";
import { injectGatewayAssistantMessage } from "./chat-inject.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

it("publishes trusted display-only install content durably and once without model text", async () => {
  await withOpenClawTestState({ label: "trusted-install-content" }, async () => {
    const config: OpenClawConfig = { agents: { entries: { main: {}, scout: {} } } };
    setRuntimeConfigSnapshot(config);
    const broadcast = vi.fn();
    const context = { getRuntimeConfig: () => config, broadcast, nodeSendToSession: vi.fn() };
    const options = {
      req: { type: "req", id: "install", method: "templates.add.apply" },
      context,
      client: null,
      respond: vi.fn(),
    } as unknown as GatewayRequestHandlerOptions;
    const prepared = await completeAgentOnboarding(options, "scout", { config });
    expect(prepared.status).toBe("completed");
    const scope = { agentId: "scout", sessionKey: prepared.sessionKey };
    const entry = loadSessionEntryReadOnly(scope)!;
    const card = {
      type: "template_plugin_install",
      pluginId: "calendar",
      packageName: "@fixture/calendar",
      displayName: "Calendar",
      status: "installed",
    };
    const injection = {
      ...scope,
      message: "",
      content: [card],
      literal: true as const,
      idempotencyKey: "install:calendar",
    };
    expect((await injectGatewayAssistantMessage(context, injection, () => {})).ok).toBe(true);
    expect(await injectGatewayAssistantMessage(context, injection, () => {})).toMatchObject({
      ok: true,
      value: { replayed: true },
    });
    const messages = (await loadTranscriptEvents({ ...scope, sessionId: entry.sessionId }))
      .filter(isRecord)
      .filter((event) => event.type === "message")
      .map((event) => event.message);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      content: [],
      openclawDisplayContent: [card],
      model: "gateway-injected",
    });
    expect(broadcast).toHaveBeenCalledTimes(1);
    expect(broadcast.mock.calls[0]?.[1]).toMatchObject({ message: { content: [card] } });
  });
});
