import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, withinTest } from "../../../test/helpers/promise.js";
import {
  createAdmittedRunOperatorAuthority,
  readAdmittedRunOperatorAuthority,
  readPreparedRunOperatorAuthority,
  resolveAdmittedRunActiveAssertion,
  type AdmittedRunOperatorAuthority,
} from "../../agents/admitted-run-context.js";
import { resolveRequesterToolPolicies } from "../../agents/requester-tool-policy.js";
import { isToolAllowedByPolicies } from "../../agents/tool-policy-match.js";
import { attachToolAllowlistIntersection } from "../../agents/tool-policy.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import * as sessionReaders from "../../config/sessions/session-transcript-worker-runtime.js";
import { defaultRuntime } from "../../runtime.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { observeMainThreadSql } from "../../test-utils/main-thread-sql-spies.test-support.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { cleanupSessionStateForTest } from "../../test-utils/session-state-cleanup.js";
import { buildEmbeddedRunExecutionParams } from "./agent-runner-utils.js";
import { prepareChannelRunAdmission } from "./channel-run-admission.js";
import { createQueueCase } from "./queue.case.test-support.js";
import { enqueueFollowupRun, scheduleFollowupDrain } from "./queue.js";
import {
  clearFollowupQueueForTest,
  createQueueTestRun as createRun,
  createQueueSettings,
  installQueueRuntimeErrorSilencer,
} from "./queue.test-helpers.js";
import { resolveFollowupDeliveryStorageKey } from "./queue/delivery-context.js";
import { admitFollowupRunLifecycle, completeFollowupRunLifecycle } from "./queue/lifecycle.js";
import { clearFollowupQueue, getExistingFollowupQueue } from "./queue/state.js";
import { resolveFollowupAbortSignal } from "./queue/types.js";
import { resolveStrandedReplyRecovery } from "./stranded-reply-recovery.js";
installQueueRuntimeErrorSilencer();
function createOperatorAuthority() {
  let references = 1;
  const controller = new AbortController();
  const authority: AdmittedRunOperatorAuthority = createAdmittedRunOperatorAuthority({
    profileId: "guest",
    scopes: ["operator.read", "operator.write"],
    source: {},
    signal: controller.signal,
    assertCurrent: () => {
      controller.signal.throwIfAborted();
      if (references <= 0) {
        throw new Error("operator source released");
      }
    },
    retain: () => {
      authority.assertCurrent();
      references += 1;
      return () => {
        references -= 1;
      };
    },
  });
  return {
    authority,
    controller,
    references: () => references,
    releaseRequest: () => {
      references -= 1;
    },
  };
}

describe("followup queue authority", () => {
  it("keeps a restricted sender's tool policy and task root through a collect drain", async () => {
    const q = createQueueCase({ mode: "collect" }, 2);
    const conversationToolPolicy = {
      allow: ["read", "sessions_spawn", "sessions_yield", "subagents"],
      deny: ["exec"],
    };
    for (const restricted of [true, false]) {
      const run = createRun({
        prompt: restricted ? "guest request" : "later unrestricted request",
        originatingChannel: "telegram",
        originatingTo: "chat-1",
      });
      run.run = {
        ...run.run,
        senderId: "sender-1",
        senderIsOwner: false,
        conversationToolPolicy: restricted ? conversationToolPolicy : undefined,
        sessionRoot: "/tmp/requester-task",
        workspaceDir: "/tmp/requester-task",
        thinkingCatalog: [{ provider: "openai", id: "gpt-test", input: ["text"] }],
        skipProviderRuntimeHints: true,
      };
      q.add(run);
    }
    try {
      await q.drain();
      expect(q.calls).toHaveLength(2);
      const observed = [];
      for (const queued of q.calls) {
        const params = await buildEmbeddedRunExecutionParams({
          run: queued.run,
          provider: "openai",
          model: "gpt-test",
          runId: `queued-${observed.length}`,
          sessionCtx: {},
          hasRepliedRef: undefined,
        });
        const policy = resolveRequesterToolPolicies({
          config: params.config,
          agentId: queued.run.agentId,
          senderId: queued.run.senderId,
          conversationPolicy: params.conversationToolPolicy,
        });
        observed.push({
          senderId: queued.run.senderId,
          senderIsOwner: params.senderIsOwner,
          source: policy.inheritedToolPolicySource,
          canSpawn: isToolAllowedByPolicies("sessions_spawn", [policy.groupPolicy]),
          canExec: isToolAllowedByPolicies("exec", [policy.groupPolicy]),
          sessionRoot: params.sessionRoot,
          workspaceDir: params.workspaceDir,
        });
      }
      expect(observed).toEqual([
        {
          senderId: "sender-1",
          senderIsOwner: false,
          source: "sender",
          canSpawn: true,
          canExec: false,
          sessionRoot: "/tmp/requester-task",
          workspaceDir: "/tmp/requester-task",
        },
        {
          senderId: "sender-1",
          senderIsOwner: false,
          source: undefined,
          canSpawn: true,
          canExec: true,
          sessionRoot: "/tmp/requester-task",
          workspaceDir: "/tmp/requester-task",
        },
      ]);
    } finally {
      clearFollowupQueueForTest(q.key);
    }
  });

  it("admits consecutive compatible operator input in FIFO order after its request returns", async () => {
    const key = "test-collect-original-operator";
    const source = createOperatorAuthority();
    const authority = source.authority;
    const variants = [
      authority,
      createAdmittedRunOperatorAuthority({
        ...authority,
        scopes: ["operator.write", "operator.read", "operator.write"],
      }),
      createAdmittedRunOperatorAuthority({ ...authority, signal: new AbortController().signal }),
      createAdmittedRunOperatorAuthority({ ...authority, profileId: "maintainer" }),
      createAdmittedRunOperatorAuthority({ ...authority, scopes: ["operator.admin"] }),
      createAdmittedRunOperatorAuthority({ ...authority, source: {} }),
      undefined,
      authority,
    ];
    const observed: Array<{ prompt: string; profileId?: string; scopes?: readonly string[] }> = [];
    const failures: unknown[] = [];
    try {
      for (const [index, operatorAuthority] of variants.entries()) {
        enqueueFollowupRun(
          key,
          {
            ...createRun({ prompt: `request ${index}`, originatingChannel: "webchat" }),
            operatorAuthority,
          },
          createQueueSettings(),
        );
      }
      source.releaseRequest();
      scheduleFollowupDrain(key, async (run) => {
        const prepared = prepareChannelRunAdmission({
          cfg: {},
          runId: `queued-operator-${observed.length}`,
          agentId: "agent",
          ingressKind: "channel",
          boundary: "auto-reply.agent-runner",
          operatorAuthority: run.operatorAuthority,
        });
        try {
          await admitFollowupRunLifecycle(run);
          const beforeAdmission = readPreparedRunOperatorAuthority(prepared);
          const context = await prepared.admit("embedded");
          const admitted = readAdmittedRunOperatorAuthority(context);
          resolveAdmittedRunActiveAssertion(context)?.();
          observed.push({
            prompt: run.prompt,
            profileId: admitted?.profileId,
            scopes: beforeAdmission?.scopes,
          });
        } catch (error) {
          failures.push(error);
        } finally {
          prepared.close();
          completeFollowupRunLifecycle(run);
        }
      });
      await vi.waitFor(() => expect(getExistingFollowupQueue(key)).toBeUndefined());
      expect(failures).toEqual([]);
      expect(observed.map((run) => run.profileId)).toEqual([
        "guest",
        "maintainer",
        "guest",
        "guest",
        undefined,
        "guest",
      ]);
      expect(observed[0]?.prompt).toContain("request 0");
      expect(observed[0]?.prompt).toContain("request 1");
      expect(observed[0]?.prompt).toContain("request 2");
      expect(observed.slice(1).map((run) => run.prompt.match(/request \d/g))).toEqual([
        ["request 3"],
        ["request 4"],
        ["request 5"],
        ["request 6"],
        ["request 7"],
      ]);
      expect(observed[2]?.scopes).toEqual(["operator.admin"]);
      expect(source.references()).toBe(0);
    } finally {
      clearFollowupQueue(key);
    }
  });

  it("keeps original grant revocation effective after collect retires an older client cancel", async () => {
    const key = "test-collect-operator-revocation";
    const source = createOperatorAuthority();
    const firstCancel = new AbortController();
    const secondCancel = new AbortController();
    const effects: string[] = [];
    const observations: boolean[] = [];
    try {
      for (const [index, abortSignal] of [firstCancel.signal, secondCancel.signal].entries()) {
        enqueueFollowupRun(
          key,
          {
            ...createRun({ prompt: `request ${index}` }),
            operatorAuthority: source.authority,
            abortSignal,
          },
          createQueueSettings(),
        );
      }
      source.releaseRequest();
      scheduleFollowupDrain(key, async (run) => {
        const prepared = prepareChannelRunAdmission({
          cfg: {},
          runId: "collected-operator-revocation",
          agentId: "agent",
          ingressKind: "channel",
          boundary: "auto-reply.agent-runner",
          operatorAuthority: run.operatorAuthority,
        });
        try {
          await admitFollowupRunLifecycle(run);
          const context = await prepared.admit("embedded");
          const assertCurrent = resolveAdmittedRunActiveAssertion(context)!;
          firstCancel.abort();
          observations.push(resolveFollowupAbortSignal(run)?.aborted === true);
          assertCurrent();
          effects.push("before revocation");
          await Promise.resolve();
          source.controller.abort();
          observations.push(resolveFollowupAbortSignal(run)?.aborted === true);
          try {
            assertCurrent();
            effects.push("after revocation");
          } catch {
            // The real admitted-run guard must reject before the modeled effect.
          }
        } finally {
          prepared.close();
          completeFollowupRunLifecycle(run);
        }
      });
      await vi.waitFor(() => expect(getExistingFollowupQueue(key)).toBeUndefined());
      expect(observations).toEqual([false, true]);
      expect(effects).toEqual(["before revocation"]);
      expect(source.references()).toBe(0);
    } finally {
      clearFollowupQueue(key);
    }
  });

  it.each(["old", "new", "summarize"] as const)(
    "releases original source holds exactly once across %s overflow and queue clearing",
    (dropPolicy) => {
      const key = `test-operator-overflow-${dropPolicy}`;
      const source = createOperatorAuthority();
      try {
        for (let index = 0; index < 5; index += 1) {
          enqueueFollowupRun(
            key,
            { ...createRun({ prompt: `request ${index}` }), operatorAuthority: source.authority },
            createQueueSettings({ cap: 1, dropPolicy }),
          );
        }
        source.releaseRequest();
        expect(source.references()).toBe(dropPolicy === "summarize" ? 3 : 1);
        clearFollowupQueue(key);
        clearFollowupQueue(key);
        expect(source.references()).toBe(0);
      } finally {
        clearFollowupQueue(key);
      }
    },
  );

  it("retains an independent operator source hold for a stranded delivery retry", async () => {
    const key = "test-operator-delivery-retry";
    const source = createOperatorAuthority();
    const parent = createRun({ prompt: "original request" });
    parent.operatorAuthority = source.authority;
    parent.turnAdoptionLifecycle = { onAdopted: () => {}, onSettled: source.releaseRequest };
    const recovery = resolveStrandedReplyRecovery({
      base: parent,
      payloads: [],
      finalText:
        "This answer must reach the original conversation. It contains enough detail to require the existing one-shot delivery recovery.",
      sourceReplyDeliveryMode: "message_tool_only",
      sendPolicyDenied: false,
      successfulSourceReplyDelivery: false,
      isHeartbeat: false,
      isRoomEvent: false,
    });
    if (recovery.kind !== "retry") {
      throw new Error("expected source delivery recovery");
    }
    let delivered = false;
    const failures: unknown[] = [];
    try {
      enqueueFollowupRun(key, recovery.run, createQueueSettings());
      completeFollowupRunLifecycle(parent);
      expect(source.references()).toBe(1);
      scheduleFollowupDrain(key, async (run) => {
        try {
          run.operatorAuthority?.assertCurrent();
          delivered = run.operatorAuthority?.profileId === "guest";
        } catch (error) {
          failures.push(error);
        } finally {
          completeFollowupRunLifecycle(run);
        }
      });
      await vi.waitFor(() => expect(getExistingFollowupQueue(key)).toBeUndefined());
      expect(failures).toEqual([]);
      expect(delivered).toBe(true);
      expect(source.references()).toBe(0);
    } finally {
      clearFollowupQueue(key);
    }
  });

  it("splits collect batches when queued authority facts change", async () => {
    const q = createQueueCase({ mode: "collect", debounceMs: 0 }, 3);
    const route = { originatingChannel: "slack" as const, originatingTo: "channel:A" };
    const pluginGrant = createRun({ prompt: "plugin grant", ...route });
    pluginGrant.run.runtimePluginToolGrant = {
      pluginId: "workboard",
      toolNames: ["workboard_complete"],
    };
    const scheduled = createRun({ prompt: "scheduled authority", ...route });
    scheduled.run.scheduledToolPolicy = { version: 1, mode: "trusted" };
    const handoff = createRun({ prompt: "trusted handoff", ...route });
    handoff.run.trustedInternalHandoff = {
      kind: "subagent-completion",
      sourceSessionKey: "agent:child",
      targetSessionKey: "agent:parent",
      targetSessionId: "session-1",
      provider: "openai",
      model: "gpt-5.6-luna",
    };
    q.add(pluginGrant);
    q.add(scheduled);
    q.add(handoff);
    q.start();
    await q.done.promise;
    expect(q.calls.map((call) => call.prompt)).toEqual([
      expect.stringContaining("plugin grant"),
      expect.stringContaining("scheduled authority"),
      expect.stringContaining("trusted handoff"),
    ]);
    expect(q.calls[0]?.run.runtimePluginToolGrant).toEqual(pluginGrant.run.runtimePluginToolGrant);
    expect(q.calls[1]?.run.scheduledToolPolicy).toEqual(scheduled.run.scheduledToolPolicy);
    expect(q.calls[2]?.run.trustedInternalHandoff).toEqual(handoff.run.trustedInternalHandoff);
  });

  it.each([
    { mode: "enabled", groups: [[0], [1, 2], [3], [4], [5]] },
    { mode: "disabled", groups: [[0, 1, 2, 3, 4, 5]] },
    { mode: "policy-deny", groups: [[0, 1, 2], [3], [4], [5]] },
  ])(
    "collects turns in order within effective screen and theme authority: $mode",
    async ({ mode, groups }) => {
      const q = createQueueCase({}, 1);
      const targets = [
        { connId: "browser-a", profileId: "profile-a" },
        { connId: "browser-b", profileId: "profile-a" },
        { connId: "browser-b", profileId: "profile-a" },
        { connId: "browser-b", profileId: "profile-b" },
        { connId: "browser-b" },
        { connId: "browser-b", profileId: "profile-a" },
      ];
      for (const [index, gatewayUiCommandTarget] of targets.entries()) {
        const run = createRun({ prompt: `selection ${index + 1}`, originatingChannel: "webchat" });
        run.run.gatewayUiCommandTarget = gatewayUiCommandTarget;
        run.run.clientCaps = ["ui-commands"];
        run.run.senderIsOwner = true;
        run.run.approvalReviewerDeviceId = "shared-device";
        run.disableTools = mode === "disabled";
        if (mode === "policy-deny") {
          run.run.config = { tools: { deny: ["screen"] } };
        }
        q.add(run);
      }
      q.start();
      await vi.waitFor(() => expect(getExistingFollowupQueue(q.key)).toBeUndefined());
      expect(q.calls).toHaveLength(groups.length);
      for (const [callIndex, group] of groups.entries()) {
        const call = q.calls[callIndex];
        expect(call?.run.gatewayUiCommandTarget).toEqual(targets[group.at(-1)!]);
        for (const index of targets.keys()) {
          const selection = `selection ${index + 1}`;
          if (group.includes(index)) {
            expect(call?.prompt).toContain(selection);
          } else {
            expect(call?.prompt).not.toContain(selection);
          }
        }
      }
    },
  );

  it.each(["collect", "overflow"] as const)(
    "rechecks screen policy after an earlier %s delivery waits",
    async (mode) => {
      const entered = createDeferredCore();
      const release = createDeferredCore();
      const settled = createDeferredCore();
      const q = createQueueCase({ cap: mode === "overflow" ? 3 : 50 });
      const sources = Array.from({ length: mode === "overflow" ? 9 : 3 }, (_, index) =>
        createRun({ prompt: `selection ${index}`, originatingChannel: "webchat" }),
      );
      sources[0]!.run.provider = "earlier-provider";
      for (const index of [1, 2]) {
        const source = sources[index]!;
        source.run.config = { tools: { deny: ["screen", "theme"] } };
        source.run.gatewayUiCommandTarget = { connId: `browser-${index}`, profileId: "viewer" };
        source.run.clientCaps = ["ui-commands"];
        source.run.senderIsOwner = true;
      }
      sources.at(-1)!.turnAdoptionLifecycle = {
        admission: "cancel-only",
        onAdopted: () => {},
        onSettled: settled.resolve,
      };
      try {
        sources.forEach((source) => q.add(source));
        q.start(async (run) => {
          q.calls.push(run);
          if (q.calls.length === 1) {
            entered.resolve();
            await release.promise;
          }
        });
        await entered.promise;
        sources[1]!.run.config = {};
        sources[2]!.run.config = {};
        release.resolve();
        await settled.promise;
        const selected = q.calls.filter((run) => /selection [12]/.test(run.prompt));
        expect(selected.map((run) => run.prompt.match(/selection [12]/g))).toEqual([
          ["selection 1"],
          ["selection 2"],
        ]);
        expect(selected.map((run) => run.run.gatewayUiCommandTarget?.connId)).toEqual([
          "browser-1",
          "browser-2",
        ]);
      } finally {
        release.resolve();
        clearFollowupQueue(q.key);
      }
    },
  );

  it("rechecks the first collect policy while the second store admission awaits", async ({
    signal,
  }) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const sessionKey = "agent:main:collect-policy";
      const firstStore = state.statePath("collect-first.sqlite");
      const secondStore = state.statePath("collect-second.sqlite");
      for (const storePath of [firstStore, secondStore]) {
        await upsertSessionEntryCore(
          { agentId: "main", sessionKey, storePath, env: state.env },
          { sessionId: "collect-policy", updatedAt: 1, sandboxMode: "off" },
        );
      }
      // Settle setup owners before observing reads, including their WAL maintenance.
      await cleanupSessionStateForTest({ stateDir: state.stateDir, rootPath: state.root });
      const sources = [firstStore, secondStore].map((storePath, index) => {
        const run = createRun({
          prompt: `policy selection ${index}`,
          originatingChannel: "webchat",
        });
        Object.assign(run.run, {
          agentId: "main",
          sessionKey,
          runtimePolicySessionKey: sessionKey,
          senderIsOwner: true,
          gatewayUiCommandTarget: { connId: "shared-browser", profileId: "viewer" },
          clientCaps: ["ui-commands"],
          config: {
            session: { store: storePath },
            agents: { defaults: { sandbox: { mode: "all" } }, entries: { main: {} } },
            tools: {
              sandbox: { tools: { allow: ["*"], deny: index === 0 ? ["screen", "theme"] : [] } },
            },
          },
        });
        return run;
      });
      const q = createQueueCase({ debounceMs: 0 }, 2);
      const entered = createDeferredCore();
      const resume = createDeferredCore();
      const firstDelivery = createDeferredCore();
      const failed = createDeferredCore<never>();
      void failed.promise.catch(() => {});
      const awaitProgress = <T>(progress: PromiseLike<T>) =>
        withinTest(Promise.race([progress, failed.promise]), signal);
      const reportFailure = vi.spyOn(defaultRuntime, "error").mockImplementation((message) => {
        if (String(message).includes(q.key)) {
          clearFollowupQueue(q.key);
          failed.reject(new Error(String(message)));
        }
      });
      const read = sessionReaders.withSessionHistoryWorkerDatabase;
      let delayed = false;
      const admission = vi
        .spyOn(sessionReaders, "withSessionHistoryWorkerDatabase")
        .mockImplementation(async (options, consume, lane) => {
          if (!delayed && options.path === secondStore) {
            delayed = true;
            entered.resolve();
            await resume.promise;
          }
          return read(options, consume, lane);
        });
      sources.forEach((source) => q.add(source));
      const calls = observeMainThreadSql();
      try {
        q.start(async (run) => {
          await q.runFollowup(run);
          firstDelivery.resolve();
        });
        await awaitProgress(
          awaitGateBeforeSettlement(
            entered.promise,
            firstDelivery.promise,
            "Second policy store was not admitted",
          ),
        );
        calls.expectIdle();
        const foreign = new DatabaseSync(firstStore);
        try {
          foreign
            .prepare(
              "UPDATE session_nodes SET entry_json = json_remove(entry_json, '$.sandboxMode') WHERE session_key = ?",
            )
            .run(sessionKey);
        } finally {
          foreign.close();
        }
        calls.clear();
        resume.resolve();
        await awaitProgress(firstDelivery.promise);
        expect(q.calls[0]?.prompt).not.toContain("policy selection 1");
        await awaitProgress(q.done.promise);
        expect(q.calls.map((run) => run.prompt.match(/policy selection [01]/g))).toEqual([
          ["policy selection 0"],
          ["policy selection 1"],
        ]);
        expect(q.calls[0]?.run.config).toBe(sources[0]!.run.config);
        expect(q.calls[1]?.run.config).toBe(sources[1]!.run.config);
        calls.expectIdle();
      } finally {
        resume.resolve();
        clearFollowupQueue(q.key);
        calls.restore();
        admission.mockRestore();
        reportFailure.mockRestore();
      }
    });
  });

  it("keys collect batches by turn allowlists, intersections, disablement, and roles", () => {
    const createAuthorityRun = () =>
      createRun({ prompt: "authority", originatingChannel: "slack", originatingTo: "channel:A" });
    const baseline = createAuthorityRun();
    const toolsAllow = createAuthorityRun();
    toolsAllow.toolsAllow = ["exec"];
    const disabled = createAuthorityRun();
    disabled.disableTools = true;
    const roles = createAuthorityRun();
    roles.run.memberRoleIds = ["operator"];
    const firstIntersection = createAuthorityRun();
    firstIntersection.toolsAllow = attachToolAllowlistIntersection(["exec"], [["exec"]]);
    const secondIntersection = createAuthorityRun();
    secondIntersection.toolsAllow = attachToolAllowlistIntersection(
      ["exec"],
      [["exec"], ["message"]],
    );
    const baselineKey = resolveFollowupDeliveryStorageKey(baseline);
    expect(resolveFollowupDeliveryStorageKey(toolsAllow)).not.toBe(baselineKey);
    expect(resolveFollowupDeliveryStorageKey(disabled)).not.toBe(baselineKey);
    expect(resolveFollowupDeliveryStorageKey(roles)).not.toBe(baselineKey);
    expect(resolveFollowupDeliveryStorageKey(firstIntersection)).not.toBe(
      resolveFollowupDeliveryStorageKey(secondIntersection),
    );
  });
});
