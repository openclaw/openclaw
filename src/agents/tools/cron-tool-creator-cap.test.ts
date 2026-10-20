import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { mergeCronPayload } from "../../cron/service/payload-merge.js";
import type { CronPayloadPatch } from "../../cron/types.js";
import { createCronScheduledToolProjection } from "../exec-tool-target-pinning.js";
import type { AnyAgentTool } from "./common.js";
import {
  capCronJobToolsAllowOnCreate,
  cronCreateRequiresCreatorAuthority,
  planCronJobUpdatePatch,
  replaceWithEffectiveCronCreatorToolAllowlist,
  resolveCronCreatorExecToolTarget,
} from "./cron-tool-creator-cap.js";
import type { CronCreatorToolAllowlistEntry } from "./cron-tool.types.js";

function testTool(name: string): AnyAgentTool {
  return {
    name,
    label: name,
    description: `${name} tool`,
    parameters: Type.Object({}),
    execute: async () => ({ content: [], details: {} }),
  };
}

function gatewayExecAlias(execTool: AnyAgentTool, ask?: "always"): AnyAgentTool {
  return createCronScheduledToolProjection(execTool, () => {}, "exec", {
    kind: "exec",
    name: "gateway_exec",
    description: "Gateway exec alias",
    followupText: "Use gateway_process for follow-up.",
    ...(ask ? { ask } : {}),
  });
}

function readyPatch(options: Parameters<typeof planCronJobUpdatePatch>[0]) {
  const plan = planCronJobUpdatePatch(options);
  expect(plan.kind).toBe("ready");
  if (plan.kind !== "ready") {
    throw new Error("expected a ready cron update patch");
  }
  return plan.patch;
}
function capture(
  tools: AnyAgentTool[],
  options?: Parameters<typeof replaceWithEffectiveCronCreatorToolAllowlist>[3],
) {
  const target: CronCreatorToolAllowlistEntry[] = [];
  replaceWithEffectiveCronCreatorToolAllowlist(target, tools, undefined, options);
  return target;
}
const agentPayload = { kind: "agentTurn" as const, message: "work" };
const wakePayload = { kind: "systemEvent" as const, text: "wake" };

describe("cron tool creator cap", () => {
  it("lets default agent turns follow their owner while scripts and Codex apps keep the creator's tools", () => {
    const triggerJob = {
      trigger: { script: "return true" },
      payload: { ...wakePayload },
    };
    const agentJob = { payload: { ...agentPayload } };
    const codexAppJob = { payload: { ...agentPayload } };
    const plainJob = {
      payload: { ...wakePayload },
    };

    capCronJobToolsAllowOnCreate(triggerJob, ["read", "cron"]);
    capCronJobToolsAllowOnCreate(agentJob, ["read", "cron"]);
    capCronJobToolsAllowOnCreate(codexAppJob, ["read", "cron"], true);
    capCronJobToolsAllowOnCreate(plainJob, ["read", "cron"]);

    // Legacy "cron" creator allowlists normalize to the canonical tool id.
    const creatorSnapshot = { toolsAllow: ["read", "automations"], toolsAllowIsDefault: true };
    expect(triggerJob.payload).toEqual({ kind: "systemEvent", text: "wake", ...creatorSnapshot });
    expect(agentJob.payload).toEqual({ kind: "agentTurn", message: "work", toolsAllow: ["*"] });
    expect(codexAppJob.payload).toEqual({ kind: "agentTurn", message: "work", ...creatorSnapshot });
    expect(plainJob.payload).toEqual(wakePayload);
  });

  it("captures the creator's tools when a wildcard agent turn becomes a script", () => {
    const patch = readyPatch({
      patch: { payload: { kind: "script", script: "return MCP.notes.read({})" } },
      creatorToolAllowlist: ["read", "notes__read"],
      currentJob: { payload: { kind: "agentTurn", message: "work", toolsAllow: ["*"] } },
    });
    expect(patch.payload).toMatchObject({ kind: "script", toolsAllow: ["read", "notes__read"] });
  });

  it("rejects unavailable explicit updates without changing the caller's patch", () => {
    const input = {
      payload: { kind: "agentTurn", toolsAllow: ["read", "exec"] },
    };

    expect(() =>
      planCronJobUpdatePatch({
        patch: input,
        creatorToolAllowlist: ["read", "cron"],
      }),
    ).toThrow('Requested automation tool "exec" cannot be carried');
    expect(input).toEqual({
      payload: { kind: "agentTurn", toolsAllow: ["read", "exec"] },
    });
  });

  it("preserves non-policy patches without loading or synthesizing authority", () => {
    expect(
      planCronJobUpdatePatch({
        patch: { enabled: false },
        creatorToolAllowlist: ["read", "cron"],
      }),
    ).toEqual({ kind: "ready", patch: { enabled: false } });
  });

  it("requests current state before deriving an implicit cap for a payload edit", () => {
    expect(
      planCronJobUpdatePatch({
        patch: { payload: { message: "updated" } },
        creatorToolAllowlist: ["read", "cron"],
      }),
    ).toEqual({ kind: "needs-current-job" });
  });

  it("preserves explicit narrower and default caps through canonical payload merge", () => {
    const storedNarrowerPayload = {
      kind: "agentTurn" as const,
      message: "work",
      toolsAllow: ["read"],
    };
    const narrower = readyPatch({
      patch: { payload: { message: "updated" } },
      creatorToolAllowlist: ["read", "exec", "cron"],
      currentJob: { payload: storedNarrowerPayload },
    });
    const storedDefaultPayload = { ...storedNarrowerPayload, toolsAllowIsDefault: true };
    const storedDefault = readyPatch({
      patch: { payload: { message: "updated" } },
      creatorToolAllowlist: ["read", "cron"],
      currentJob: { payload: storedDefaultPayload },
    });

    expect(narrower).toEqual({ payload: { kind: "agentTurn", message: "updated" } });
    expect(mergeCronPayload(storedNarrowerPayload, narrower.payload as CronPayloadPatch)).toEqual({
      kind: "agentTurn",
      message: "updated",
      toolsAllow: ["read"],
    });
    expect(storedDefault).toEqual({ payload: { kind: "agentTurn", message: "updated" } });
    expect(
      mergeCronPayload(storedDefaultPayload, storedDefault.payload as CronPayloadPatch),
    ).toEqual({
      kind: "agentTurn",
      message: "updated",
      toolsAllow: ["read"],
      toolsAllowIsDefault: true,
    });
  });

  it("inherits kind for kind-less patches independently of creator policy", () => {
    const patch = { payload: { model: null } };
    expect(
      planCronJobUpdatePatch({
        patch,
        creatorToolAllowlist: undefined,
      }),
    ).toEqual({ kind: "needs-current-job" });

    expect(
      readyPatch({
        patch,
        creatorToolAllowlist: undefined,
        currentJob: { payload: agentPayload },
      }),
    ).toEqual({ payload: { kind: "agentTurn", model: null } });
  });

  it("captures a host-created gateway alias under its canonical exec identity", () => {
    const alias = gatewayExecAlias(testTool("exec"), "always");
    const target: CronCreatorToolAllowlistEntry[] = [];

    replaceWithEffectiveCronCreatorToolAllowlist(target, [alias, testTool("read")]);

    expect(target).toEqual([
      {
        name: "exec",
        aliasName: "gateway_exec",
        execTarget: { host: "gateway", ask: "always" },
      },
      { name: "read" },
    ]);
    expect(resolveCronCreatorExecToolTarget(target)).toEqual({
      host: "gateway",
      ask: "always",
    });
  });

  it("captures an unregistered same-name tool literally, never as shell authority", () => {
    const target = capture([testTool("gateway_exec")]);

    expect(target).toEqual([{ name: "gateway_exec" }]);
    expect(resolveCronCreatorExecToolTarget(target)).toBeUndefined();
  });

  it("drops the restrict-only pin when a direct unpinned exec grant also exists", () => {
    const execTool = testTool("exec");
    const alias = gatewayExecAlias(testTool("exec"));
    const aliasFirst = capture([alias, execTool]);
    const directFirst = capture([execTool, alias]);

    expect(aliasFirst).toEqual([{ name: "exec", aliasName: "gateway_exec" }]);
    expect(directFirst).toEqual([{ name: "exec", aliasName: "gateway_exec" }]);
    expect(resolveCronCreatorExecToolTarget(aliasFirst)).toBeUndefined();
    expect(resolveCronCreatorExecToolTarget(directFirst)).toBeUndefined();
  });

  it("keeps a guarded gateway exec pin when the native harness also owns shell", () => {
    const target = capture([gatewayExecAlias(testTool("exec"), "always")], {
      canonicalToolNames: ["exec", "process"],
    });

    expect(target).toEqual([
      { name: "exec", aliasName: "gateway_exec", execTarget: { host: "gateway", ask: "always" } },
      { name: "process" },
    ]);
    expect(resolveCronCreatorExecToolTarget(target)).toEqual({ host: "gateway", ask: "always" });
  });

  it("pins native shell authority to the gateway host only when the caller vouches for it", () => {
    const pinned = capture([testTool("read")], {
      canonicalToolNames: ["exec", "process", "read", "web_fetch"],
      nativeExecTarget: { host: "gateway" },
    });
    const unpinned = capture([testTool("read")], {
      canonicalToolNames: ["exec", "process"],
    });

    expect(pinned).toEqual([
      { name: "read" },
      { name: "exec", execTarget: { host: "gateway" } },
      { name: "process" },
      { name: "web_fetch" },
    ]);
    expect(resolveCronCreatorExecToolTarget(pinned)).toEqual({ host: "gateway" });
    expect(unpinned).toEqual([{ name: "read" }, { name: "exec" }, { name: "process" }]);
    expect(resolveCronCreatorExecToolTarget(unpinned)).toBeUndefined();
  });

  it("never pins a direct unpinned exec grant because the native shell also exists", () => {
    const target = capture([testTool("exec")], {
      canonicalToolNames: ["exec"],
      nativeExecTarget: { host: "gateway" },
    });

    expect(target).toEqual([{ name: "exec" }]);
    expect(resolveCronCreatorExecToolTarget(target)).toBeUndefined();
  });

  it("captures native question authority without requiring an OpenClaw tool object", () => {
    const target = capture([testTool("read")], {
      canonicalToolNames: ["read", "ask_user"],
    });

    expect(target).toEqual([{ name: "read" }, { name: "ask_user" }]);
  });

  it("rejects a backend-projected name outside the native capability vocabulary", () => {
    for (const rejected of [
      "Bash",
      "AskUserQuestion",
      "READ",
      " exec ",
      "apply-patch",
      "gateway_exec",
      "browser",
      "",
      "*",
    ]) {
      expect(() =>
        capture([testTool("read")], {
          canonicalToolNames: ["read", rejected],
        }),
      ).toThrow(/non-canonical native capability/);
    }
  });

  it("keeps only restrictions shared by duplicate gateway aliases", () => {
    const guarded = gatewayExecAlias(testTool("exec"), "always");
    const unguarded = gatewayExecAlias(testTool("exec"));
    const guardedFirst = capture([guarded, unguarded]);
    const unguardedFirst = capture([unguarded, guarded]);

    expect(resolveCronCreatorExecToolTarget(guardedFirst)).toEqual({ host: "gateway" });
    expect(resolveCronCreatorExecToolTarget(unguardedFirst)).toEqual({ host: "gateway" });
  });

  it("caps explicit alias-name requests to the canonical persisted tool id", () => {
    const alias = gatewayExecAlias(testTool("exec"));
    const creator = capture([alias, testTool("read")]);

    for (const requested of [["gateway_exec"], ["exec"], ["gateway_exec", "read"]]) {
      const job = {
        trigger: { script: "return { fire: false }" },
        payload: { kind: "systemEvent", text: "wake", toolsAllow: [...requested] },
      };
      capCronJobToolsAllowOnCreate(job, creator);
      const expected = requested.includes("read") ? ["exec", "read"] : ["exec"];
      expect(job.payload.toolsAllow).toEqual(expected);
    }

    const unrelated = {
      trigger: { script: "return { fire: false }" },
      payload: { kind: "systemEvent", text: "wake", toolsAllow: ["write"] },
    };
    expect(() => capCronJobToolsAllowOnCreate(unrelated, creator)).toThrow(
      'Requested automation tool "write" cannot be carried',
    );
  });

  it("treats an alias-name finite request as already covered by creator authority", () => {
    const alias = gatewayExecAlias(testTool("exec"));
    const creator = capture([alias]);

    const job = {
      trigger: { script: "return { fire: false }" },
      payload: { kind: "systemEvent", text: "wake", toolsAllow: ["gateway_exec"] },
    };
    expect(cronCreateRequiresCreatorAuthority(job, creator)).toBe(false);
    expect(
      cronCreateRequiresCreatorAuthority(
        {
          trigger: { script: "return { fire: false }" },
          payload: { kind: "systemEvent", text: "wake", toolsAllow: ["exec", "browser"] },
        },
        creator,
      ),
    ).toBe(true);
  });
});
