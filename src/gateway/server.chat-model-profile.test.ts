import { randomUUID } from "node:crypto";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resolveAgentDir } from "../agents/agent-scope.js";
import { upsertAuthProfile } from "../agents/auth-profiles.js";
import { withFullRuntimeReplyConfig } from "../auto-reply/reply/get-reply-fast-path.js";
import * as replyRun from "../auto-reply/reply/get-reply-run.js";
import { getReplyFromConfig } from "../auto-reply/reply/get-reply.js";
import { getRuntimeConfig, readConfigFileSnapshot } from "../config/config.js";
import { loadSessionEntry } from "../config/sessions/session-accessor.js";
import { getSessionWorkAdmissionRelease } from "../sessions/session-lifecycle-admission.js";
import { createDirectChatContext } from "./server-chat.agent-events.test-helpers.js";
import { handleGatewayRequest } from "./server-methods.js";
import type { GatewayClient, GatewayRequestContext, RespondFn } from "./server-methods/types.js";
import {
  agentDiscoveryMock,
  createGatewaySuiteHarness,
  dispatchInboundMessageMock,
  gatewayReplyMock,
  installGatewayTestHooks,
  prepareGatewayReplyRuntimeForTest,
  testState,
  writeSessionStore,
} from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });
const temporaryDirs = useAutoCleanupTempDirTracker(afterEach);
const runPreparedReply = vi.spyOn(replyRun, "runPreparedReply");
const sessionKey = "agent:main:main";
const sessionId = "quoted-profile-session";
const siblingKey = "agent:main:sibling";
const priorSelection = {
  providerOverride: "openai",
  modelOverride: "current-model",
  modelOverrideSource: "user" as const,
  modelOverrideRouteResolution: "resolved" as const,
  authProfileOverride: "openai:before",
  authProfileOverrideSource: "user" as const,
};
const client: GatewayClient = {
  connId: "quoted-profile-ui",
  connect: {
    minProtocol: 1,
    maxProtocol: 1,
    role: "operator",
    scopes: ["operator.read", "operator.write", "operator.admin"],
    client: { id: "openclaw-control-ui", version: "test", platform: "test", mode: "webchat" },
  },
};
let harness: Awaited<ReturnType<typeof createGatewaySuiteHarness>>;
let context: GatewayRequestContext;
let storePath: string;

beforeAll(async () => {
  harness = await createGatewaySuiteHarness();
});

afterAll(async () => {
  await harness.close();
  runPreparedReply.mockRestore();
});

beforeEach(async () => {
  const directory = temporaryDirs.make("openclaw-chat-model-profile-");
  storePath = path.join(directory, "sessions.json");
  testState.sessionStorePath = storePath;
  testState.agentConfig = {
    workspace: path.join(directory, "workspace"),
    model: { primary: "openai/default-model" },
    models: {
      "openai/default-model": {},
      "openai/current-model": {},
      "openai/test-model": {},
      "openai/alias-model": { alias: "opus" },
      "sample/model name@20260101": {},
    },
  };
  agentDiscoveryMock.enabled = true;
  agentDiscoveryMock.models = [
    { provider: "openai", id: "default-model", name: "Default model", reasoning: false },
    { provider: "openai", id: "current-model", name: "Current model", reasoning: false },
    { provider: "openai", id: "test-model", name: "Test model", reasoning: false },
    { provider: "openai", id: "alias-model", name: "Alias model", reasoning: false },
    { provider: "sample", id: "model name@20260101", name: "Versioned model", reasoning: false },
  ];
  await writeSessionStore({
    entries: {
      main: { sessionId, updatedAt: Date.now(), ...priorSelection },
      [siblingKey]: {
        sessionId: "sibling-profile-session",
        updatedAt: Date.now(),
        ...priorSelection,
      },
    },
  });
  upsertAuthProfile({
    agentDir: resolveAgentDir(getRuntimeConfig(), "main"),
    profileId: "openai:before",
    credential: { type: "api_key", provider: "openai", key: "synthetic-before-key" },
  });
  await prepareGatewayReplyRuntimeForTest({ force: true });
  context = createDirectChatContext({ getRuntimeConfig });
  gatewayReplyMock.mockImplementation((ctx, options, config) =>
    getReplyFromConfig(ctx, options, withFullRuntimeReplyConfig(config ?? getRuntimeConfig())),
  );
  dispatchInboundMessageMock.mockReset();
  // Directive parsing, profile resolution, and session writes stay on the real chat path.
  runPreparedReply.mockReset().mockResolvedValue({ text: "Model received the message." });
});

afterEach(async () => {
  await getSessionWorkAdmissionRelease({ scope: storePath, identities: [sessionKey, sessionId] });
  testState.sessionStorePath = undefined;
  testState.agentConfig = undefined;
  gatewayReplyMock.mockReset();
  runPreparedReply.mockReset();
  Object.assign(agentDiscoveryMock, { enabled: false, models: [] });
});

async function sendChat(message: string) {
  const respond = vi.fn<RespondFn>();
  const requestId = randomUUID();
  await handleGatewayRequest({
    req: {
      type: "req",
      id: requestId,
      method: "chat.send",
      params: { sessionKey, message, idempotencyKey: requestId },
    },
    context,
    client,
    respond,
    isWebchatConnect: () => true,
  });
  expect(respond.mock.calls[0]?.[0]).toBe(true);
  expect(respond.mock.calls[0]?.[1]).toMatchObject({ status: "started" });
  await getSessionWorkAdmissionRelease({ scope: storePath, identities: [sessionKey, sessionId] });
  expect(context.logGateway.error).not.toHaveBeenCalled();
  expect(context.chatAbortControllers.size).toBe(0);
}

describe("chat.send quoted model profiles", () => {
  it.each([
    [
      '/model openai/test-model@"openai:owner+work@example.com" -s',
      "openai:owner+work@example.com",
      "openai",
      "test-model",
    ],
    [
      '/model openai/test-model@"openai:Work account" -s',
      "openai:Work account",
      "openai",
      "test-model",
    ],
    [
      String.raw`/model openai/test-model@"openai:Work \"account\"\\primary" -s`,
      'openai:Work "account"\\primary',
      "openai",
      "test-model",
    ],
    [
      '/model openai/test-model@"openai:Work --global" -s',
      "openai:Work --global",
      "openai",
      "test-model",
    ],
    ['/model openai/test-model@"openai:team/work" -s', "openai:team/work", "openai", "test-model"],
    ['/model openai/test-model@"20260101" -s', "20260101", "openai", "test-model"],
    [
      '/model "sample/model name@20260101"@"sample:team/work" -s',
      "sample:team/work",
      "sample",
      "model name@20260101",
    ],
  ])(
    "persists the exact model and profile only in this session: %s",
    async (command, profile, provider, model) => {
      upsertAuthProfile({
        agentDir: resolveAgentDir(getRuntimeConfig(), "main"),
        profileId: profile,
        credential: { type: "api_key", provider, key: "synthetic-selected-key" },
      });
      const configBefore = await readConfigFileSnapshot();
      await sendChat(command);
      expect(loadSessionEntry({ sessionKey, storePath })).toMatchObject({
        sessionId,
        providerOverride: provider,
        modelOverride: model,
        authProfileOverride: profile,
        authProfileOverrideSource: "user",
      });
      expect(loadSessionEntry({ sessionKey: siblingKey, storePath })).toMatchObject(priorSelection);
      expect(getRuntimeConfig().agents?.defaults?.model).toEqual({
        primary: "openai/default-model",
      });
      expect((await readConfigFileSnapshot()).raw).toBe(configBefore.raw);
      expect(runPreparedReply).not.toHaveBeenCalled();
    },
  );

  it.each([
    String.raw`openai/test@"work\N"`,
    String.raw`openai/test@"work\U0041"`,
    String.raw`openai/test@"work\v"`,
    'openai/test@"unfinished',
    String.raw`"sample/model\N"@"work"`,
    '"unfinished',
  ])(
    "preserves malformed quoted input without selecting its trailing alias: %s",
    async (reference) => {
      const command = `/model ${reference} -s /opus -g`;
      const configBefore = await readConfigFileSnapshot();
      await sendChat(command);
      expect(runPreparedReply).toHaveBeenCalledOnce();
      expect(runPreparedReply.mock.calls[0]?.[0]).toMatchObject({
        provider: "openai",
        model: "current-model",
        sessionCtx: { agentText: command, BodyForAgent: command },
        directives: { hasModelDirective: false, cleaned: command },
      });
      const directives = runPreparedReply.mock.calls[0]?.[0].directives;
      expect(directives?.rawModelDirective).toBeUndefined();
      expect(directives?.rawModelProfile).toBeUndefined();
      expect(directives?.modelScope).toBeUndefined();
      expect(loadSessionEntry({ sessionKey, storePath })).toMatchObject(priorSelection);
      expect(loadSessionEntry({ sessionKey: siblingKey, storePath })).toMatchObject(priorSelection);
      expect(getRuntimeConfig().agents?.defaults?.model).toEqual({
        primary: "openai/default-model",
      });
      expect((await readConfigFileSnapshot()).raw).toBe(configBefore.raw);
    },
  );
});
