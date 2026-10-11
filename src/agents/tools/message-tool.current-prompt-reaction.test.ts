import { Check } from "typebox/schema";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { makeUserMessage } from "../../../test/helpers/user-message.js";
import {
  buildThreadingToolContext,
  mintReplyMessageActionTurnCapability,
} from "../../auto-reply/reply/agent-runner-utils.js";
import { resolveReactionMessageId } from "../../channels/plugins/actions/reaction-message-id.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.sqlite-entry.js";
import { setSessionReactionAsync } from "../../config/sessions/session-reaction-store.js";
import { listSessionReactions } from "../../config/sessions/session-reaction-store.test-support.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createCurrentPromptReaction } from "../../gateway/current-prompt-reaction.js";
import {
  resolveMessageActionTurnAuthorization,
  resolveMessageActionTurnCapability,
  revokeMessageActionTurnCapability,
} from "../../gateway/message-action-turn-capability.js";
import * as workerAdmission from "../../infra/sqlite-worker-operation-admission.js";
import { sqliteWorkerOwnerProbe } from "../../infra/sqlite-worker-owner-probe.test-support.js";
import {
  bindUserTurnPromptReactionSource,
  readUserTurnPromptReactionSource,
} from "../../sessions/user-turn-transcript-admission.js";
import { attachRuntimeUserTurnTranscriptContext } from "../../sessions/user-turn-transcript-runtime-context.js";
import { createUserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
import { createOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { prepareSystemAgentRunAdmission } from "../admitted-run-context.js";
import { isDeliveredMessageToolOnlySourceReplyResult } from "../embedded-agent-message-tool-source-reply.js";
import { guardSessionManager } from "../session-tool-result-guard-wrapper.js";
import { SessionManager } from "../sessions/session-manager.js";
import {
  createAdmittedGatewayToolCallerIdentity,
  withGatewayToolCallerIdentity,
} from "./gateway-caller-context.js";
import { createMessageTool } from "./message-tool-execution.js";

const EMPTY_CATALOG = { version: 0, channels: [], getChannel: () => undefined } as const;

describe("admitted WebChat prompt reactions", () => {
  let state: Awaited<ReturnType<typeof createOpenClawTestState>>;
  let run: ReturnType<typeof prepareSystemAgentRunAdmission>;
  let recorder: ReturnType<typeof createUserTurnTranscriptRecorder>;
  let caller: ReturnType<typeof createAdmittedGatewayToolCallerIdentity>;
  let scope: { agentId: string; sessionKey: string; sessionId: string };
  let config: OpenClawConfig;
  let token: string;
  let runId: string;
  let index = 0;
  let sourceCurrent: boolean;
  const broadcast = vi.fn();
  const external =
    vi.fn<NonNullable<NonNullable<Parameters<typeof createMessageTool>[0]>["runMessageAction"]>>();

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
    sourceCurrent = true;
    broadcast.mockClear();
    external.mockReset().mockResolvedValue({
      kind: "action",
      action: "react",
      channel: "discord",
      handledBy: "plugin",
      payload: { ok: true },
      dryRun: false,
    });
    await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
    recorder = createUserTurnTranscriptRecorder({
      input: { text: "Please check this", sender: { id: "human", name: "Human" } },
      target: { ...scope, sessionEntry: undefined },
    });
    run = prepareSystemAgentRunAdmission(config, runId, scope.agentId, "reaction-test");
    caller = createAdmittedGatewayToolCallerIdentity({
      admittedRunContext: await run.admit("embedded"),
      agentId: scope.agentId,
      sessionKey: scope.sessionKey,
    });
    bindSource(recorder);
    token = mintForRecorder(recorder, runId);
  });
  afterEach(() => {
    revokeMessageActionTurnCapability(token);
    run.close();
    vi.restoreAllMocks();
  });

  function bindSource(input: ReturnType<typeof createUserTurnTranscriptRecorder>) {
    const source = {
      agentId: scope.agentId,
      sessionKey: scope.sessionKey,
      assertCurrent: () => {
        if (!sourceCurrent) {
          throw new Error("Original prompt authority revoked");
        }
      },
      createReaction: (sourceRecorder: ReturnType<typeof createUserTurnTranscriptRecorder>) =>
        createCurrentPromptReaction({
          ...scope,
          recorder: sourceRecorder,
          context: { broadcast, getRuntimeConfig: () => config },
        }),
    };
    bindUserTurnPromptReactionSource(input, source);
    return source;
  }

  function mintForRecorder(
    input: ReturnType<typeof createUserTurnTranscriptRecorder>,
    executionRunId: string,
  ) {
    const minted = mintReplyMessageActionTurnCapability(
      {
        followupRun: {
          prompt: "Prompt",
          enqueuedAt: 0,
          userTurnTranscriptRecorder: input,
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
          },
        },
        sessionCtx: { Provider: "webchat", MessageSid: runId },
        opts: {
          dashboardReadAdmission: { ...scope, runId, assertCurrent: run.assertSourceCurrent },
        },
        isHeartbeat: false,
      },
      executionRunId,
    );
    if (!minted) {
      throw new Error("Expected a recorder-owned reaction capability");
    }
    return minted;
  }

  function tool(overrides: NonNullable<Parameters<typeof createMessageTool>[0]> = {}) {
    return createMessageTool({
      config,
      preparedMessageToolCatalog: EMPTY_CATALOG,
      agentId: scope.agentId,
      agentSessionKey: scope.sessionKey,
      sessionId: scope.sessionId,
      runId,
      currentChannelProvider: "webchat",
      messageActionTurnCapability: token,
      runMessageAction: external,
      getScopedChannelsCommandSecretTargets: () => ({ targetIds: new Set<string>() }),
      resolveCommandSecretRefsViaGateway: async ({ config: inputConfig }) => ({
        resolvedConfig: inputConfig,
        diagnostics: [],
        targetStatesByPath: {},
        hadUnresolvedTargets: false,
      }),
      ...overrides,
    });
  }
  function execute(args: Record<string, unknown>, selected = tool()) {
    return withGatewayToolCallerIdentity(caller, () =>
      selected.execute("reaction", { action: "react", emoji: "👍", ...args }),
    );
  }
  async function persist() {
    await recorder.persistApproved();
    const receipt = recorder.getAdmissionReceipt();
    if (!receipt) {
      throw new Error("fixture prompt was not committed");
    }
    return receipt.entryId;
  }

  it("commits the agent's current-prompt reaction and publishes only actual changes", async () => {
    const messageId = await persist();
    expect(messageId).not.toBe(runId);
    await setSessionReactionAsync(scope, {
      messageId,
      emoji: "👍",
      identityId: "human",
      expectedSessionId: scope.sessionId,
    });
    const selected = tool({
      currentChannelProvider: "discord",
      currentChannelId: "inherited-room",
    });
    expect(Check(selected.parameters, { action: "react", emoji: "👍" })).toBe(true);
    const added = await execute({ final: false }, selected);
    expect(added.details).toMatchObject({ messageId, changed: true });
    expect(
      isDeliveredMessageToolOnlySourceReplyResult({
        sourceReplyDeliveryMode: "automatic",
        toolName: "message",
        args: { action: "react", final: false },
        result: added,
      }),
    ).toBe(false);
    expect(listSessionReactions(scope, { sessionId: scope.sessionId })[messageId]).toEqual([
      {
        emoji: "👍",
        count: 2,
        identities: expect.arrayContaining([
          { id: "human" },
          { id: "agent:main", label: "Test Agent" },
        ]),
      },
    ]);
    expect(broadcast).toHaveBeenCalledWith(
      "session.reaction",
      expect.objectContaining({
        messageId,
        actor: { type: "agent", id: "main", label: "Test Agent" },
        action: "added",
      }),
      { sessionKeys: [scope.sessionKey], agentId: "main" },
    );
    await execute({ final: true }, selected);
    expect(broadcast).toHaveBeenCalledTimes(1);
    const removed = await execute({ remove: true, final: true }, selected);
    expect(removed.details).not.toHaveProperty("messageDelivery.sourceReplyDelivered");
    await execute({ remove: true }, selected);
    expect(broadcast).toHaveBeenCalledTimes(2);
    expect(listSessionReactions(scope, { sessionId: scope.sessionId })[messageId]).toEqual([
      { emoji: "👍", count: 1, identities: [{ id: "human" }] },
    ]);
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
    expect(broadcast).not.toHaveBeenCalled();
    expect(external).not.toHaveBeenCalled();
    expect(listSessionReactions(scope, { sessionId: scope.sessionId })).toEqual({});
  });

  it("keeps source-reply-only tools send-only even with a current-prompt grant", async () => {
    await persist();
    const selected = tool({ sourceReplyOnly: true });
    expect(Check(selected.parameters, { action: "send", message: "Done" })).toBe(true);
    expect(Check(selected.parameters, { action: "react", emoji: "👍" })).toBe(false);
    await expect(execute({ final: true }, selected)).rejects.toThrow('permit only action "send"');
    expect(broadcast).not.toHaveBeenCalled();
    expect(external).not.toHaveBeenCalled();
    expect(listSessionReactions(scope, { sessionId: scope.sessionId })).toEqual({});
  });

  it("honors the message action allowlist without widening the discovered schema", async () => {
    await persist();
    const selected = tool({
      config: { ...config, tools: { message: { actions: { allow: ["send"] } } } },
    });
    expect(Check(selected.parameters, { action: "react", emoji: "👍" })).toBe(false);
    await expect(execute({}, selected)).rejects.toThrow('Message action "react" is disabled');
    expect(broadcast).not.toHaveBeenCalled();
    expect(external).not.toHaveBeenCalled();
  });

  it("rolls back a reaction when its capability expires at SQLite commit", async () => {
    await persist();
    const selected = tool();
    const lookup = { ...scope, runId, token };
    const serializedContext = resolveMessageActionTurnCapability(lookup);
    expect(serializedContext).not.toHaveProperty("currentPromptReaction");
    expect(() => structuredClone(serializedContext)).not.toThrow();
    expect(resolveMessageActionTurnAuthorization(lookup)).not.toHaveProperty(
      "currentPromptReaction",
    );
    let commitRequests = 0;
    const probe = sqliteWorkerOwnerProbe.admission(workerAdmission, (request, grant, admit) => {
      if (request.stage === "commit") {
        commitRequests++;
        revokeMessageActionTurnCapability(token);
      }
      return admit(request, grant);
    });
    await expect(execute({}, selected)).rejects.toThrow(
      "message action turn capability is no longer active",
    );
    expect(commitRequests).toBeGreaterThan(0);
    probe.mockRestore();
    expect(broadcast).not.toHaveBeenCalled();
    expect(listSessionReactions(scope, { sessionId: scope.sessionId })).toEqual({});
  });

  it.each(["run close", "revocation", "expiry"])(
    "fences retained tools after %s",
    async (reason) => {
      await persist();
      const selected = tool();
      if (reason === "run close") {
        run.close();
      }
      if (reason === "revocation") {
        revokeMessageActionTurnCapability(token);
      }
      if (reason === "expiry") {
        vi.spyOn(Date, "now").mockReturnValue(Number.MAX_SAFE_INTEGER);
      }
      await expect(execute({}, selected)).rejects.toThrow();
      expect(broadcast).not.toHaveBeenCalled();
      expect(listSessionReactions(scope, { sessionId: scope.sessionId })).toEqual({});
    },
  );

  it("binds queued execution to its own recorder and new run without inheriting read permission", async () => {
    const originalId = await persist();
    const queued = createUserTurnTranscriptRecorder({
      input: { text: "Queued prompt" },
      target: { ...scope, sessionEntry: undefined },
    });
    bindSource(queued);
    await queued.persistApproved();
    const queuedId = queued.getAdmissionReceipt()?.entryId;
    const queuedRunId = runId + "-queued";
    const queuedAdmission = prepareSystemAgentRunAdmission(
      config,
      queuedRunId,
      scope.agentId,
      "queued-reaction-test",
    );
    const queuedCaller = createAdmittedGatewayToolCallerIdentity({
      admittedRunContext: await queuedAdmission.admit("embedded"),
      agentId: scope.agentId,
      sessionKey: scope.sessionKey,
    });
    expect(
      mintReplyMessageActionTurnCapability(
        {
          followupRun: {
            prompt: "Copied input",
            enqueuedAt: 0,
            userTurnTranscriptRecorder: { ...queued },
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
            },
          },
          sessionCtx: { Provider: "webchat" },
          isHeartbeat: false,
          opts: {
            dashboardReadAdmission: { ...scope, runId, assertCurrent: run.assertSourceCurrent },
          },
        },
        queuedRunId,
      ),
    ).toBeUndefined();
    const queuedToken = mintForRecorder(queued, queuedRunId);
    try {
      expect(
        resolveMessageActionTurnCapability({ ...scope, runId: queuedRunId, token }),
      ).toBeUndefined();
      expect(
        resolveMessageActionTurnAuthorization({ ...scope, runId: queuedRunId, token: queuedToken })
          ?.assertDashboardReadCurrent,
      ).toBeUndefined();
      const selected = tool({ runId: queuedRunId, messageActionTurnCapability: queuedToken });
      const result = await withGatewayToolCallerIdentity(queuedCaller, () =>
        selected.execute("queued-react", { action: "react", emoji: "👍" }),
      );
      expect(result.details).toMatchObject({ messageId: queuedId, changed: true });
      expect(
        listSessionReactions(scope, { sessionId: scope.sessionId })[originalId],
      ).toBeUndefined();
      sourceCurrent = false;
      await expect(
        withGatewayToolCallerIdentity(queuedCaller, () =>
          selected.execute("queued-remove", { action: "react", emoji: "👍", remove: true }),
        ),
      ).rejects.toThrow("Original prompt authority revoked");
    } finally {
      revokeMessageActionTurnCapability(queuedToken);
      queuedAdmission.close();
    }
  });

  it("retains authenticated source custody when the queue collects inputs", async () => {
    const second = createUserTurnTranscriptRecorder({
      input: { text: "Second" },
      target: { ...scope, sessionEntry: undefined },
    });
    bindSource(second);
    const collected = createUserTurnTranscriptRecorder({
      input: { text: "Collected input" },
      target: { ...scope, sessionEntry: undefined },
      pendingInputSources: [recorder, second],
    });
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
      revokeMessageActionTurnCapability(collectedToken);
    }
  });

  it("moves a retained tool to a steered prompt only after native transcript consumption", async () => {
    const originalId = await persist();
    const selected = tool();
    const steered = createUserTurnTranscriptRecorder({
      input: { text: "Steered prompt" },
      target: { ...scope, sessionEntry: undefined },
    });
    bindSource(steered);
    await steered.stageApproved?.({ runId: runId + "-steer", assertCurrent: () => {} });
    await execute({}, selected);
    expect(listSessionReactions(scope, { sessionId: scope.sessionId })[originalId]).toBeDefined();
    expect(steered.getAdmissionReceipt()).toBeUndefined();
    const prepared = await steered.resolveMessage();
    if (!prepared) {
      throw new Error("Expected prepared steering message");
    }
    const original = recorder.getAdmissionReceipt();
    if (!original) {
      throw new Error("Expected original committed prompt");
    }
    const target = { ...scope, storePath: original.storePath };
    const manager = guardSessionManager(
      await SessionManager.openAsync(target, state.workspaceDir),
      { ...scope, runId, config },
    );
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
    expect(listSessionReactions(scope, { sessionId: scope.sessionId })[originalId]).toHaveLength(1);
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
    expect(broadcast).not.toHaveBeenCalled();
    expect(listSessionReactions(scope, { sessionId: "successor-session" })).toEqual({});
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
    await execute(
      { channel: "discord", target: "channel:external", messageId: "external-message" },
      selected,
    );
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
    expect(listSessionReactions(scope, { sessionId: scope.sessionId })[messageId]).toBeUndefined();
  });
});
