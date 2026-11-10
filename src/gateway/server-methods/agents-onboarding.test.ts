import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as config from "../../config/config.js";
import * as snapshots from "../../config/runtime-snapshot.js";
import {
  loadSessionEntryReadOnly,
  loadTranscriptEvents,
} from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { AsyncWorkScope, getAsyncWorkSignal } from "../../shared/async-work-scope.js";
import { verifySetupInferenceConfig } from "../../system-agent/setup-inference-turn.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import * as sessionCreation from "../session-create-service.js";
import {
  completeAgentOnboarding,
  prepareAgentOnboarding,
  startAgentOnboardingConversation,
} from "./agents-onboarding.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

const { sendInternalChat, waitForAgentJob } = vi.hoisted(() => ({
  sendInternalChat: vi.fn(),
  waitForAgentJob: vi.fn(),
}));
// mock-isolation: hold the existing chat completion owner at its terminal boundary.
vi.mock(import("../agent-turn/agent-job.js"), () => ({ waitForAgentJob }));
// mock-isolation: inspect the prepared onboarding dispatch without running a second chat owner.
vi.mock(import("./chat-send-handler.js"), () => ({
  handleTrustedInternalChatSend: sendInternalChat,
}));

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
const verified = { ok: true as const, modelRef: "ollama/test-model", latencyMs: 1 };
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
  waitForAgentJob.mockReset().mockResolvedValue({
    status: "ok",
    terminalReply: { disposition: "visible", text: "Fixture personality greeting" },
  });
});
afterEach(() => vi.restoreAllMocks());
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
  vi.mocked(verifySetupInferenceConfig).mockResolvedValue(verified);
  const options = invocation();
  const prepared = await prepareAgentOnboarding(options, "bot-stable", {
    name: "New agent",
    onboarding: true,
  });
  expect(prepared.expectedConfigHash).toBe("source-hash");
  expect(vi.mocked(verifySetupInferenceConfig).mock.calls[0]?.[0]).toMatchObject({
    agentId: "bot-stable",
    modelTarget: "primary",
    requireExecutionOwner: false,
  });
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
    return verified;
  });
  await expect(
    prepareAgentOnboarding(options, "bot-stable", { name: "New agent" }),
  ).rejects.toThrow("Gateway settings changed");
});
it("prepares ordinary agent chat without a canned assistant greeting", async () => {
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
    expect(messages).toEqual([]);
  });
});

it("prepares Template chat without a canned assistant greeting or model run", async () => {
  await withOpenClawTestState({ label: "template-empty-opening" }, async () => {
    const prospective: OpenClawConfig = { ...cfg, agents: { entries: { main: {}, scout: {} } } };
    sendInternalChat.mockClear();
    const receipt = await completeAgentOnboarding(invocation(), "scout", {
      config: prospective,
    });
    expect(receipt).toMatchObject({ status: "completed", sessionKey: "agent:scout:home" });
    const entry = loadSessionEntryReadOnly({ agentId: "scout", sessionKey: receipt.sessionKey });
    expect(entry?.sessionId).toBeTruthy();
    const events = await loadTranscriptEvents({
      agentId: "scout",
      sessionKey: receipt.sessionKey,
      sessionId: entry!.sessionId,
    });
    expect(events.filter(isRecord).filter((event) => event.type === "message")).toEqual([]);
    expect(sendInternalChat).not.toHaveBeenCalled();
  });
});

it("asks for one of four roles in plain text without tools", async () => {
  const release = vi.fn();
  const work = new AsyncWorkScope();
  const options = invocation();
  options.sessionMutationAuthorization = {
    retain: () => release,
  } as unknown as GatewayRequestHandlerOptions["sessionMutationAuthorization"];
  let sendWorkSignal: AbortSignal | undefined;
  sendInternalChat.mockReset().mockImplementation(async (request: GatewayRequestHandlerOptions) => {
    sendWorkSignal = getAsyncWorkSignal();
    request.respond(true, { status: "started" });
  });

  await work.track(() =>
    startAgentOnboardingConversation(options, "bot-stable", "agent:bot-stable:home"),
  );
  await work.drain();

  const [request, , internalOptions] = sendInternalChat.mock.calls[0]!;
  expect(request.params.message).toContain("Ask the user in plain text");
  expect(request.params.message).not.toContain("introduction has already been saved");
  expect(request.params.message).not.toContain("Ask User");
  expect(request.params.message).not.toContain("JSON");
  expect(request.params).toMatchObject({
    sessionKey: "agent:bot-stable:home",
    agentId: "bot-stable",
    deliver: false,
    suppressCommandInterpretation: true,
    systemInputProvenance: {
      kind: "internal_system",
      sourceTool: "agents_create_onboarding",
    },
  });
  expect(request.params.message).toContain("What role would you like me to take on?");
  expect(request.params.message).toMatch(/do not offer a team/i);
  expect(request.params.message).toContain("Ask only about the role in this opening turn");
  expect(request.params.message).toContain("do not ask for their goal");
  expect(request.params.message).toContain("one open-ended follow-up");
  expect(internalOptions).toMatchObject({
    transcript: { display: false },
    toolsAllow: [],
  });
  expect(sendWorkSignal).toBeUndefined();
  expect(waitForAgentJob).not.toHaveBeenCalled();
  expect(release).toHaveBeenCalledOnce();
});
it("starts one normal Template personality greeting without the four-role question or tools", async () => {
  const release = vi.fn();
  const options = invocation();
  options.sessionMutationAuthorization = {
    retain: () => release,
  } as unknown as GatewayRequestHandlerOptions["sessionMutationAuthorization"];
  sendInternalChat.mockReset().mockImplementation(async (request: GatewayRequestHandlerOptions) => {
    request.respond(true, { status: "started" });
  });
  await startAgentOnboardingConversation(options, "scout", "agent:scout:home", "template");
  expect(sendInternalChat).toHaveBeenCalledOnce();
  const [request, , internal] = sendInternalChat.mock.calls[0]!;
  expect(request.params.message).toContain("SOUL personality");
  expect(request.params.message).toContain("installer owns all remaining declared setup");
  expect(request.params.message).not.toContain("What role would you like me to take on?");
  expect(request.params.message).not.toContain("Chief of staff");
  expect(request.params.systemInputProvenance).toEqual({
    kind: "internal_system",
    sourceTool: "agents_create_onboarding",
  });
  expect(internal).toMatchObject({ transcript: { display: false }, toolsAllow: [] });
  expect(waitForAgentJob).toHaveBeenCalledWith({
    runId: "agents.create:scout:template-greeting",
    source: "chat",
    timeoutMs: 120_000,
  });
  expect(release).toHaveBeenCalledOnce();
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

it("reconciles an exact unpublished session when preparation throws after commit", async () => {
  await withOpenClawTestState({ label: "onboarding-lost-preparation-reply" }, async () => {
    const prospective: OpenClawConfig = {
      ...cfg,
      agents: { entries: { main: {}, "pending-fixture": {} } },
    };
    const create = sessionCreation.createGatewaySession;
    vi.spyOn(sessionCreation, "createGatewaySession").mockImplementationOnce(async (params) => {
      const created = await create(params);
      expect(created.ok).toBe(true);
      throw new Error("Fixture reply lost after durable commit");
    });
    const result = await completeAgentOnboarding(invocation(cfg), "pending-fixture", {
      config: prospective,
    });
    expect(result).toMatchObject({ status: "error" });
    expect(
      loadSessionEntryReadOnly({ agentId: "pending-fixture", sessionKey: result.sessionKey }),
    ).toBeUndefined();
  });
});

it.each([
  null,
  { status: "error", error: "Fixture provider failed" },
  { status: "ok", terminalReply: { disposition: "silent" } },
])("does not report the Template opening ready without visible output: %j", async (terminal) => {
  waitForAgentJob.mockResolvedValueOnce(terminal);
  sendInternalChat.mockReset().mockImplementation(async (request: GatewayRequestHandlerOptions) => {
    request.respond(true, { status: "started" });
  });
  await expect(
    startAgentOnboardingConversation(invocation(), "scout", "agent:scout:home", "template"),
  ).rejects.toThrow(/Template opening/);
});

it("reports failed Template opening admission instead of completing silently", async () => {
  sendInternalChat.mockReset().mockImplementation(async (request: GatewayRequestHandlerOptions) => {
    request.respond(false, undefined, {
      code: "UNAVAILABLE",
      message: "Fixture model unavailable",
    });
  });
  await expect(
    startAgentOnboardingConversation(invocation(), "scout", "agent:scout:home", "template"),
  ).rejects.toThrow("Fixture model unavailable");
});
