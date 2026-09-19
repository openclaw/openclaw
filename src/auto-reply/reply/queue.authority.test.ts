import { describe, expect, it, vi } from "vitest";
import { attachToolAllowlistIntersection } from "../../agents/tool-policy.js";
import { enqueueFollowupRun, scheduleFollowupDrain, type QueueSettings } from "./queue.js";
import {
  createQueueTestRun as createRun,
  createQueueSettings,
  createDrainRecorder,
  installQueueRuntimeErrorSilencer,
} from "./queue.test-helpers.js";
import { resolveFollowupDeliveryContextKey } from "./queue/delivery-context.js";
import { getExistingFollowupQueue } from "./queue/state.js";

installQueueRuntimeErrorSilencer();

describe("followup queue authority", () => {
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
