import { describe, expect, it, vi } from "vitest";
import {
  createAdmittedRunOperatorAuthority,
  readAdmittedRunOperatorAuthority,
  readPreparedRunOperatorAuthority,
  resolveAdmittedRunActiveAssertion,
  type AdmittedRunOperatorAuthority,
} from "../../agents/admitted-run-context.js";
import { attachToolAllowlistIntersection } from "../../agents/tool-policy.js";
import { prepareChannelRunAdmission } from "./channel-run-admission.js";
import { enqueueFollowupRun, scheduleFollowupDrain, type QueueSettings } from "./queue.js";
import {
  createQueueTestRun as createRun,
  createQueueSettings,
  createDrainRecorder,
  installQueueRuntimeErrorSilencer,
} from "./queue.test-helpers.js";
import { resolveFollowupDeliveryContextKey } from "./queue/delivery-context.js";
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
            {
              ...createRun({ prompt: `request ${index}` }),
              operatorAuthority: source.authority,
            },
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
    const key = `test-collect-queued-authority-split-${Date.now()}`;
    const { calls, done, runFollowup } = createDrainRecorder(3);
    const settings: QueueSettings = { mode: "collect", debounceMs: 0 };
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

    enqueueFollowupRun(key, pluginGrant, settings);
    enqueueFollowupRun(key, scheduled, settings);
    enqueueFollowupRun(key, handoff, settings);
    scheduleFollowupDrain(key, runFollowup);
    await done.promise;

    expect(calls.map((call) => call.prompt)).toEqual([
      expect.stringContaining("plugin grant"),
      expect.stringContaining("scheduled authority"),
      expect.stringContaining("trusted handoff"),
    ]);
    expect(calls[0]?.run.runtimePluginToolGrant).toEqual(pluginGrant.run.runtimePluginToolGrant);
    expect(calls[1]?.run.scheduledToolPolicy).toEqual(scheduled.run.scheduledToolPolicy);
    expect(calls[2]?.run.trustedInternalHandoff).toEqual(handoff.run.trustedInternalHandoff);
  });

  it("drains different provider and model routes under their own run snapshots", async () => {
    const key = `test-collect-route-authority-split-${Date.now()}`;
    const { calls, done, runFollowup } = createDrainRecorder(3);
    const settings: QueueSettings = { mode: "collect", debounceMs: 0 };
    const route = { originatingChannel: "slack" as const, originatingTo: "channel:A" };
    const first = createRun({ prompt: "first route", ...route });
    first.run.provider = "openai";
    first.run.model = "gpt-primary";
    const second = createRun({ prompt: "second route", ...route });
    second.run.provider = "openai";
    second.run.model = "gpt-fallback";
    const third = createRun({ prompt: "third route", ...route });
    third.run.provider = "anthropic";
    third.run.model = "gpt-fallback";

    enqueueFollowupRun(key, first, settings);
    enqueueFollowupRun(key, second, settings);
    enqueueFollowupRun(key, third, settings);
    scheduleFollowupDrain(key, runFollowup);
    await done.promise;

    expect(calls.map((call) => [call.prompt, call.run.provider, call.run.model])).toEqual([
      [expect.stringContaining("first route"), "openai", "gpt-primary"],
      [expect.stringContaining("second route"), "openai", "gpt-fallback"],
      [expect.stringContaining("third route"), "anthropic", "gpt-fallback"],
    ]);
  });

  it.each([
    { mode: "enabled", groups: [[0], [1, 2], [3], [4], [5]] },
    { mode: "disabled", groups: [[0, 1, 2, 3, 4, 5]] },
    { mode: "policy-deny", groups: [[0, 1, 2], [3], [4], [5]] },
    { mode: "runtime-cap", groups: [[0, 1, 2, 3, 4, 5]] },
    { mode: "runtime-theme", groups: [[0, 1, 2], [3], [4], [5]] },
    { mode: "non-owner", groups: [[0, 1, 2], [3], [4], [5]] },
    { mode: "no-capability", groups: [[0, 1, 2], [3], [4], [5]] },
    { mode: "theme-deny", groups: [[0, 1, 2, 3, 4, 5]] },
  ])(
    "collects turns in order within effective screen and theme authority: $mode",
    async ({ mode, groups }) => {
      const key = `test-collect-ui-requester-${Date.now()}`;
      const { calls, runFollowup } = createDrainRecorder();
      const settings = createQueueSettings();
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
        run.run.clientCaps = mode === "no-capability" ? [] : ["ui-commands"];
        run.run.senderIsOwner = mode !== "non-owner";
        run.run.approvalReviewerDeviceId = "shared-device";
        run.disableTools = mode === "disabled";
        if (mode === "policy-deny") {
          run.run.config = { tools: { deny: ["screen"] } };
        }
        if (mode === "runtime-cap") {
          run.toolsAllow = ["read"];
        }
        if (mode === "runtime-theme") {
          run.toolsAllow = ["theme"];
        }
        if (mode === "theme-deny") {
          run.run.config = { tools: { deny: ["screen", "theme"] } };
        }
        enqueueFollowupRun(key, run, settings);
      }

      scheduleFollowupDrain(key, runFollowup);
      await vi.waitFor(() => expect(getExistingFollowupQueue(key)).toBeUndefined());

      expect(calls).toHaveLength(groups.length);
      for (const [callIndex, group] of groups.entries()) {
        const call = calls[callIndex];
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

  it("keys collect batches by turn allowlists, intersections, disablement, and roles", () => {
    const createAuthorityRun = () =>
      createRun({
        prompt: "authority",
        originatingChannel: "slack",
        originatingTo: "channel:A",
      });
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

    const baselineKey = resolveFollowupDeliveryContextKey(baseline);
    expect(resolveFollowupDeliveryContextKey(toolsAllow)).not.toBe(baselineKey);
    expect(resolveFollowupDeliveryContextKey(disabled)).not.toBe(baselineKey);
    expect(resolveFollowupDeliveryContextKey(roles)).not.toBe(baselineKey);
    expect(resolveFollowupDeliveryContextKey(firstIntersection)).not.toBe(
      resolveFollowupDeliveryContextKey(secondIntersection),
    );
  });
});
