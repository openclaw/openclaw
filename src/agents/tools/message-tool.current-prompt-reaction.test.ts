import { Check } from "typebox/schema";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { makeUserMessage } from "../../../test/helpers/user-message.js";
import {
  buildThreadingToolContext,
  mintReplyMessageActionTurnCapability,
} from "../../auto-reply/reply/agent-runner-utils.js";
import { resolveReactionMessageId } from "../../channels/plugins/actions/reaction-message-id.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.sqlite-entry.js";
import { listSessionReactions } from "../../config/sessions/session-reaction-store.test-support.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createCurrentPromptReaction } from "../../gateway/current-prompt-reaction.js";
import {
  resolveMessageActionTurnAuthorization as authorization,
  resolveMessageActionTurnCapability as capability,
  revokeMessageActionTurnCapability as revoke,
} from "../../gateway/message-action-turn-capability.js";
import * as messageActionRunner from "../../infra/outbound/message-action-runner.js";
import * as workerAdmission from "../../infra/sqlite-worker-operation-admission.js";
import { sqliteWorkerOwnerProbe } from "../../infra/sqlite-worker-owner-probe.test-support.js";
import { createReplyOperation } from "../../sessions/session-controller.js";
import { captureSessionTarget } from "../../sessions/session-controller.lifecycle.js";
import {
  bindUserTurnPromptReactionSource,
  readUserTurnPromptReactionSource,
} from "../../sessions/user-turn-transcript-admission.js";
import { attachRuntimeUserTurnTranscriptContext } from "../../sessions/user-turn-transcript-runtime-context.js";
import { createUserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
import { createOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { prepareSystemAgentRunAdmission as prepareRun } from "../admitted-run-context.js";
import { isDeliveredMessageToolOnlySourceReplyResult } from "../embedded-agent-message-tool-source-reply.js";
import { guardSessionManager } from "../session-tool-result-guard-wrapper.js";
import { SessionManager } from "../sessions/session-manager.js";
import {
  createAdmittedGatewayToolCallerIdentity,
  withGatewayToolCallerIdentity,
} from "./gateway-caller-context.js";
import { createMessageTool } from "./message-tool-execution.js";

const EMPTY_CATALOG = { version: 0, channels: [], getChannel: () => undefined } as const;
const EXTERNAL_TARGET = {
  channel: "discord",
  target: "channel:external",
  messageId: "external-message",
};
const AGENT_IDENTITY = { id: "agent:main", label: "Test Agent" };
type Recorder = ReturnType<typeof createUserTurnTranscriptRecorder>;
type ToolOptions = NonNullable<Parameters<typeof createMessageTool>[0]>;
function required<T>(value: T | undefined): T {
  if (value === undefined) {
    throw new Error("Expected fixture value");
  }
  return value;
}

let state: Awaited<ReturnType<typeof createOpenClawTestState>>;
let run: ReturnType<typeof prepareRun>;
let recorder: Recorder;
let caller: ReturnType<typeof createAdmittedGatewayToolCallerIdentity>;
let scope: { agentId: string; sessionKey: string; sessionId: string };
let config: OpenClawConfig;
let token: string;
let runId: string;
let index = 0;
let sourceCurrent: boolean;
const broadcast = vi.fn();
const external = vi.fn<typeof messageActionRunner.runMessageAction>();

beforeAll(async () => {
  state = await createOpenClawTestState({ scenario: "minimal" });
});
afterAll(async () => {
  await state.cleanup();
});
beforeEach(async () => {
  runId = "prompt-reaction-run-" + index++;
  scope = {
    agentId: "main",
    sessionKey: "agent:main:dashboard:" + runId,
    sessionId: runId + "-session",
  };
  config = { agents: { entries: { main: { identity: { name: "Test Agent" } } } } };
  setRuntimeConfigSnapshot(config);
  sourceCurrent = true;
  broadcast.mockClear();
  vi.spyOn(messageActionRunner, "runMessageAction").mockImplementation(external);
  external.mockReset().mockResolvedValue({
    kind: "action",
    action: "react",
    channel: "discord",
    handledBy: "plugin",
    payload: { ok: true },
    dryRun: false,
  });
  await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
  recorder = prompt("Please check this", { id: "human", name: "Human" });
  run = prepareRun(config, runId, scope.agentId, "reaction-test");
  caller = await admitCaller(run);
  bindSource(recorder);
  token = mintForRecorder(recorder, runId);
});
afterEach(() => {
  revoke(token);
  run.close();
  clearRuntimeConfigSnapshot();
  vi.restoreAllMocks();
});

async function admitCaller(admission: typeof run) {
  return createAdmittedGatewayToolCallerIdentity({
    admittedRunContext: await admission.admit("embedded"),
    agentId: scope.agentId,
    sessionKey: scope.sessionKey,
  });
}
function bindSource(input: Recorder) {
  const source = {
    agentId: scope.agentId,
    sessionKey: scope.sessionKey,
    assertCurrent: () => {
      if (!sourceCurrent) {
        throw new Error("Original prompt authority revoked");
      }
    },
    createReaction: (sourceRecorder: Recorder) =>
      createCurrentPromptReaction({
        ...scope,
        recorder: sourceRecorder,
        context: { broadcast, getRuntimeConfig: () => config },
      }),
  };
  bindUserTurnPromptReactionSource(input, source);
}

function mintTurn(
  input: Recorder,
  executionRunId: string,
  kind: { internalEventExecution?: boolean } = {},
  copied = false,
) {
  return mintReplyMessageActionTurnCapability(
    {
      followupRun: {
        prompt: "Prompt",
        enqueuedAt: 0,
        userTurnTranscriptRecorder: copied ? { ...input } : input,
        run: {
          ...scope,
          sessionFile: scope.sessionKey,
          agentDir: state.agentDir(),
          workspaceDir: state.workspaceDir,
          config,
          provider: "openai",
          model: "test",
          messageProvider: "webchat",
          timeoutMs: 1000,
          blockReplyBreak: "message_end",
          ...(kind.internalEventExecution && {
            internalEventExecution: { onStarted() {}, onTerminal() {} },
          }),
        },
      },
      sessionCtx: copied ? { Provider: "webchat" } : { Provider: "webchat", MessageSid: runId },
      opts: {
        dashboardReadAdmission: { ...scope, runId, assertCurrent: run.assertSourceCurrent },
      },
    },
    executionRunId,
  );
}

function mintForRecorder(input: Recorder, executionRunId: string) {
  return required(mintTurn(input, executionRunId));
}

function tool(overrides: ToolOptions = {}) {
  return createMessageTool({
    config,
    preparedMessageToolCatalog: EMPTY_CATALOG,
    agentId: scope.agentId,
    agentSessionKey: scope.sessionKey,
    sessionId: scope.sessionId,
    runId,
    currentChannelProvider: "webchat",
    messageActionTurnCapability: token,
    ...overrides,
  });
}
function execute(args: Record<string, unknown>, selected = tool(), identity = caller) {
  return withGatewayToolCallerIdentity(identity, () =>
    selected.execute("reaction", { action: "react", emoji: "👍", ...args }),
  );
}
async function persist() {
  await recorder.persistApproved();
  return required(recorder.getAdmissionReceipt()).entryId;
}

function expectNoReaction(sessionId = scope.sessionId) {
  expect(broadcast).not.toHaveBeenCalled();
  expect(external).not.toHaveBeenCalled();
  expect(reactions(sessionId)).toEqual({});
}

function reactions(sessionId = scope.sessionId) {
  return listSessionReactions(scope, { sessionId });
}

function prompt(
  text: string,
  sender?: { id: string; name: string },
  pendingInputSources?: Recorder[],
) {
  return createUserTurnTranscriptRecorder({
    input: { text, ...(sender && { sender }) },
    target: { ...scope, sessionEntry: undefined },
    pendingInputSources,
  });
}

it("fails prompt reactions locally on a Discord-routed internal event that mints no grant", async () => {
  const nextRunId = runId + "-next";
  const grant = mintTurn(recorder, nextRunId, { internalEventExecution: true });
  expect(grant).toBeUndefined();
  const nextRun = tool({
    currentChannelProvider: "discord",
    runId: nextRunId,
    messageActionTurnCapability: grant,
  });
  for (const args of [
    {},
    { channel: "WebChat" },
    { target: "channel:external", messageId: "external-message" },
  ]) {
    await expect(execute(args, nextRun)).rejects.toThrow("No prompt here permits reactions");
  }
  expect(external).not.toHaveBeenCalled();
  expect(broadcast).not.toHaveBeenCalled();
  await execute(EXTERNAL_TARGET, nextRun);
  expect(external).toHaveBeenCalledOnce();
});

it("commits and publishes the agent identity on the current prompt despite an inherited route", async () => {
  const messageId = await persist();
  expect(messageId).not.toBe(runId);
  const selected = tool({
    currentChannelProvider: "discord",
    currentChannelId: "inherited-room",
  });
  expect(Check(selected.parameters, { action: "react", emoji: "👍" })).toBe(true);
  const added = await execute({ final: false }, selected);
  expect(added.details).toMatchObject({ messageId, changed: true });
  expect(reactions()[messageId]).toEqual([{ emoji: "👍", count: 1, identities: [AGENT_IDENTITY] }]);
  expect(broadcast).toHaveBeenCalledWith(
    "session.reaction",
    expect.objectContaining({
      messageId,
      actor: { type: "agent", id: "main", label: "Test Agent" },
      action: "added",
    }),
    { sessionKeys: [scope.sessionKey], agentId: "main" },
  );
  expect(external).not.toHaveBeenCalled();
});

it("reserves source completion for an explicit terminal addition, never acknowledgments or no-ops", async () => {
  await persist();
  for (const { args, complete } of [
    { args: {}, complete: false },
    { args: { final: false }, complete: false },
    { args: { final: true, dryRun: true }, complete: false },
    { args: { final: true, remove: true }, complete: false },
    { args: { final: true }, complete: true },
    { args: { final: true }, complete: false },
  ]) {
    const result = await execute(args);
    expect(
      isDeliveredMessageToolOnlySourceReplyResult({
        sourceReplyDeliveryMode: "automatic",
        toolName: "message",
        args: { action: "react", ...args },
        result,
      }),
    ).toBe(complete);
  }
  expect(external).not.toHaveBeenCalled();
});

it("records a terminal reaction on its exact source despite a colliding physical session", async () => {
  const messageId = await persist();
  const createOperation = (storeScope: string) =>
    createReplyOperation({
      sessionKey: scope.sessionKey,
      sessionId: scope.sessionId,
      resetTriggered: false,
      target: captureSessionTarget({
        storeScope,
        sessionKey: scope.sessionKey,
        incarnation: scope.sessionId,
      }),
    });
  const operation = createOperation(required(recorder.getAdmissionReceipt()).storePath);
  const competingOperation = createOperation(state.path("other", "sessions.json"));
  operation.attachBackend({ kind: "embedded", runId, cancel() {} });
  try {
    await execute({ final: true });
    expect(broadcast).toHaveBeenCalledOnce();
    expect(reactions()[messageId]).toEqual([
      { emoji: "👍", count: 1, identities: [AGENT_IDENTITY] },
    ]);
    expect(operation.sourceReplyDelivered).toBe(true);
    expect(competingOperation.sourceReplyDelivered).toBe(false);
    expect(external).not.toHaveBeenCalled();
  } finally {
    operation.complete();
    competingOperation.complete();
  }
});

it("requires a committed host-owned prompt and rejects model-selected targets or identities", async () => {
  await expect(execute({})).rejects.toThrow("has not been committed");
  await persist();
  for (const args of [
    { messageId: runId },
    { message_id: runId },
    { target: "other" },
    { identityId: "human" },
    { accountId: "other" },
    { emoji: "not-emoji" },
  ]) {
    await expect(execute(args)).rejects.toThrow();
  }
  expectNoReaction();
});

it.each([
  { sourceReplyOnly: true, error: 'permit only action "send"' },
  { sourceReplyOnly: false, error: 'Message action "react" is disabled' },
])("enforces send-only execution policy ($sourceReplyOnly)", async (policy) => {
  await persist();
  const selected = tool(
    policy.sourceReplyOnly
      ? { sourceReplyOnly: true }
      : { config: { ...config, tools: { message: { actions: { allow: ["send"] } } } } },
  );
  if (!policy.sourceReplyOnly) {
    expect(Check(selected.parameters, { action: "react", emoji: "👍" })).toBe(false);
  }
  await expect(execute(policy.sourceReplyOnly ? { final: true } : {}, selected)).rejects.toThrow(
    policy.error,
  );
  expectNoReaction();
});

it("rolls back a reaction when its capability expires at SQLite commit", async () => {
  await persist();
  const selected = tool();
  const lookup = { ...scope, runId, token };
  const serializedContext = capability(lookup);
  expect(serializedContext).not.toHaveProperty("currentPromptReaction");
  expect(() => structuredClone(serializedContext)).not.toThrow();
  expect(authorization(lookup)).not.toHaveProperty("currentPromptReaction");
  let commitRequests = 0;
  const probe = sqliteWorkerOwnerProbe.admission(workerAdmission, (request, grant, admit) => {
    if (request.stage === "commit") {
      commitRequests++;
      revoke(token);
    }
    return admit(request, grant);
  });
  await expect(execute({}, selected)).rejects.toThrow(
    "message action turn capability is no longer active",
  );
  expect(commitRequests).toBeGreaterThan(0);
  probe.mockRestore();
  expectNoReaction();
});

it.each([
  ["run close", () => run.close()],
  ["revocation", () => revoke(token)],
  ["expiry", () => vi.spyOn(Date, "now").mockReturnValue(Number.MAX_SAFE_INTEGER)],
] as const)("fences retained tools after %s", async (_reason, invalidate) => {
  await persist();
  const selected = tool();
  invalidate();
  await expect(execute({}, selected)).rejects.toThrow();
  const rebuilt = tool();
  expect(rebuilt.description).toBe(selected.description);
  expect(rebuilt.parameters).toEqual(selected.parameters);
  await expect(execute({}, rebuilt)).rejects.toThrow();
  expectNoReaction();
});

it("binds queued execution to its own recorder and new run without inheriting read permission", async () => {
  const originalId = await persist();
  const queued = prompt("Queued prompt");
  bindSource(queued);
  await queued.persistApproved();
  const queuedId = queued.getAdmissionReceipt()?.entryId;
  const queuedRunId = runId + "-queued";
  const queuedAdmission = prepareRun(config, queuedRunId, scope.agentId, "queued-reaction-test");
  const queuedCaller = await admitCaller(queuedAdmission);
  expect(mintTurn(queued, queuedRunId, {}, true)).toBeUndefined();
  const queuedToken = mintForRecorder(queued, queuedRunId);
  try {
    expect(capability({ ...scope, runId: queuedRunId, token })).toBeUndefined();
    expect(
      authorization({ ...scope, runId: queuedRunId, token: queuedToken })
        ?.assertDashboardReadCurrent,
    ).toBeUndefined();
    const selected = tool({ runId: queuedRunId, messageActionTurnCapability: queuedToken });
    const result = await execute({}, selected, queuedCaller);
    expect(result.details).toMatchObject({ messageId: queuedId, changed: true });
    expect(reactions()[originalId]).toBeUndefined();
    sourceCurrent = false;
    await expect(execute({ remove: true }, selected, queuedCaller)).rejects.toThrow(
      "Original prompt authority revoked",
    );
  } finally {
    revoke(queuedToken);
    queuedAdmission.close();
  }
});

it("retains authenticated source custody when the queue collects inputs", async () => {
  const second = prompt("Second");
  bindSource(second);
  const collected = prompt("Collected input", undefined, [recorder, second]);
  expect(readUserTurnPromptReactionSource(collected)).toBeDefined();
  await collected.persistApproved();
  const collectedToken = mintForRecorder(collected, runId);
  try {
    const result = await execute({}, tool({ messageActionTurnCapability: collectedToken }));
    expect(result.details).toMatchObject({
      messageId: collected.getAdmissionReceipt()?.entryId,
      changed: true,
    });
  } finally {
    revoke(collectedToken);
  }
});

it("moves a retained tool to a steered prompt only after native transcript consumption", async () => {
  const originalId = await persist();
  const selected = tool();
  const steered = prompt("Steered prompt");
  bindSource(steered);
  await steered.stageApproved?.({ runId: runId + "-steer", assertCurrent: () => {} });
  await execute({}, selected);
  expect(reactions()[originalId]).toBeDefined();
  expect(steered.getAdmissionReceipt()).toBeUndefined();
  const prepared = required(await steered.resolveMessage());
  const original = required(recorder.getAdmissionReceipt());
  const target = { ...scope, storePath: original.storePath };
  const manager = guardSessionManager(await SessionManager.openAsync(target, state.workspaceDir), {
    ...scope,
    runId,
    config,
  });
  const runtime = attachRuntimeUserTurnTranscriptContext(
    makeUserMessage("Steered prompt", Date.now()),
    { message: prepared, recorder: steered },
  );
  await manager.appendMessageAsync(runtime);
  const steeredId = steered.getAdmissionReceipt()?.entryId;
  expect(steeredId).toBeTruthy();
  expect(steeredId).not.toBe(originalId);
  const result = await execute({}, selected);
  expect(result.details).toMatchObject({ messageId: steeredId, changed: true });
  expect(reactions()[originalId]).toHaveLength(1);
  sourceCurrent = false;
  await expect(execute({ remove: true }, selected)).rejects.toThrow(
    "Original prompt authority revoked",
  );
});

it("rejects reactions after session reset instead of adopting the successor prompt", async () => {
  await persist();
  const selected = tool();
  await upsertSessionEntryCore(scope, { sessionId: "successor-session", updatedAt: 2 });
  await expect(execute({}, selected)).rejects.toThrow("session changed before reaction mutation");
  expectNoReaction("successor-session");
});

it("keeps explicit external reactions separate and never substitutes the WebChat run ID", async () => {
  const messageId = await persist();
  const threading = buildThreadingToolContext({
    sessionCtx: {
      Provider: "webchat",
      OriginatingChannel: "discord",
      OriginatingTo: "channel:external",
      MessageSid: runId,
    },
    config,
    hasRepliedRef: undefined,
  });
  expect(resolveReactionMessageId({ args: {}, toolContext: threading })).toBeUndefined();
  const selected = tool(threading);
  await execute(EXTERNAL_TARGET, selected);
  expect(external).toHaveBeenCalledWith(
    expect.objectContaining({
      action: "react",
      params: expect.objectContaining({ channel: "discord", messageId: "external-message" }),
    }),
  );
  expect(external.mock.calls[0]?.[0].messageActionAuthorization).not.toHaveProperty(
    "currentPromptReaction",
  );
  expect(broadcast).not.toHaveBeenCalled();
  expect(reactions()[messageId]).toBeUndefined();
});
