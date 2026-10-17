import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as config from "../../config/config.js";
import * as snapshots from "../../config/runtime-snapshot.js";
import {
  loadSessionEntryReadOnly,
  loadTranscriptEvents,
} from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { isTranscriptOnlyOpenClawAssistantMessage } from "../../shared/transcript-only-openclaw-assistant.js";
import { verifySetupInferenceConfig } from "../../system-agent/setup-inference-turn.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { prepareAgentOnboarding, completeAgentOnboarding } from "./agents-onboarding.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

// mock-isolation: control inference availability without contacting a real provider.
vi.mock(import("../../system-agent/setup-inference-turn.js"), () => ({
  verifySetupInferenceConfig: vi.fn(),
}));
// mock-isolation: test durable transcript publication without a running Gateway event broadcaster.
vi.mock(import("./session-change-event.js"), () => ({ emitSessionsChanged: vi.fn() }));

const cfg: OpenClawConfig = {
  agents: { entries: { main: {} }, defaults: { model: "ollama/test-model" } },
  session: { mainKey: "home" },
};
function invocation(runtimeConfig: OpenClawConfig = cfg) {
  return {
    req: { type: "req", id: "creation", method: "agents.create" },
    context: { getRuntimeConfig: () => runtimeConfig, isConfigReloadSettled: () => true },
    client: { connect: { client: { mode: "ui" }, scopes: ["operator.admin"] } },
    respond: vi.fn(),
  } as unknown as GatewayRequestHandlerOptions;
}
beforeEach(() => {
  vi.mocked(verifySetupInferenceConfig).mockReset();
});
afterEach(() => {
  vi.restoreAllMocks();
});
function activeConfig() {
  vi.spyOn(snapshots, "getRuntimeConfigAppliedHash").mockReturnValue(
    snapshots.hashRuntimeConfigValue(cfg),
  );
  vi.spyOn(config, "readConfigFileSnapshot").mockResolvedValue({
    exists: true,
    valid: true,
    sourceConfig: cfg,
    config: cfg,
    runtimeConfig: cfg,
    hash: "source-hash",
  } as Awaited<ReturnType<typeof config.readConfigFileSnapshot>>);
}
it("verifies primary inference before creation without using its output as the greeting", async () => {
  activeConfig();
  vi.mocked(verifySetupInferenceConfig).mockResolvedValue({
    ok: true,
    modelRef: "ollama/test-model",
    latencyMs: 1,
  });
  const options = invocation();
  const prepared = await prepareAgentOnboarding(options, "bot-stable", {
    name: "New agent",
    onboarding: true,
  });
  expect(prepared.expectedConfigHash).toBe("source-hash");
  expect(verifySetupInferenceConfig).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      agentId: "bot-stable",
      modelTarget: "primary",
      requireExecutionOwner: false,
    }),
  );
  expect(cfg.agents?.entries).not.toHaveProperty("bot-stable");
  options.context.getRuntimeConfig = () => ({ ...cfg });
  expect(prepared.assertCurrent).toThrow("Gateway settings changed");
});
it("rejects failed inference and settings drift before persistence", async () => {
  activeConfig();
  vi.mocked(verifySetupInferenceConfig).mockResolvedValueOnce({
    ok: false,
    status: "unavailable",
    error: "Provider offline",
  });
  await expect(
    prepareAgentOnboarding(invocation(), "bot-stable", { name: "New agent" }),
  ).rejects.toThrow("Provider offline");
  const options = invocation();
  vi.mocked(verifySetupInferenceConfig).mockImplementationOnce(async () => {
    options.context.getRuntimeConfig = () => ({ ...cfg });
    return {
      ok: true,
      modelRef: "ollama/test-model",
      latencyMs: 1,
    };
  });
  await expect(
    prepareAgentOnboarding(options, "bot-stable", { name: "New agent" }),
  ).rejects.toThrow("Gateway settings changed");
});
it("atomically publishes a saved greeting that remains in the agent's conversation context", async () => {
  await withOpenClawTestState({ label: "created-agent-onboarding" }, async () => {
    const runtimeConfig: OpenClawConfig = { ...cfg, agents: { entries: { main: {} } } };
    const options = invocation(runtimeConfig);
    const recordCreatedSession = vi.fn();
    options.sessionMutationAuthorization = {
      assertCurrent: vi.fn(),
      assertTargetCurrent: vi.fn(),
      recordCreatedSession,
    };
    const receipt = await completeAgentOnboarding(options, "main");
    expect(receipt).toEqual({ status: "completed", sessionKey: "agent:main:home" });
    const entry = loadSessionEntryReadOnly({ agentId: "main", sessionKey: receipt.sessionKey });
    expect(recordCreatedSession).toHaveBeenCalledOnce();
    expect(recordCreatedSession.mock.calls[0]?.[0].entry.initializationPending).toBeUndefined();
    expect(entry?.initializationPending).toBeUndefined();
    expect(entry?.sessionId).toBeTruthy();
    const events = await loadTranscriptEvents({
      agentId: "main",
      sessionKey: receipt.sessionKey,
      sessionId: entry!.sessionId,
    });
    const messages = events
      .filter(isRecord)
      .filter((event) => event.type === "message")
      .map((event) => event.message);
    expect(messages).toEqual([
      expect.objectContaining({
        role: "assistant",
        content: [{ type: "text", text: "Hi! What would you like to call me?" }],
        api: "openclaw-transcript",
        provider: "openclaw",
        model: "onboarding",
        usage: expect.objectContaining({ input: 0, output: 0, totalTokens: 0 }),
      }),
    ]);
    expect(messages.some((message) => isRecord(message) && message.role === "user")).toBe(false);
    expect(isTranscriptOnlyOpenClawAssistantMessage(messages[0])).toBe(false);
  });
});
it("reports failed transcript admission without changing the already-created agent receipt", async () => {
  const options = invocation();
  options.hasCurrentClientAuthority = () => false;
  const result = await completeAgentOnboarding(options, "main");
  expect(result).toEqual({
    status: "error",
    sessionKey: "agent:main:home",
    error: expect.stringContaining("authority changed"),
  });
});
