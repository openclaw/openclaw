import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import {
  cronCreateRequiresStreamExecAuthority,
  cronMutationRequiresStreamExecAuthority,
  cronUpdateRequiresStreamExecAuthority,
} from "../../cron/stream-exec-authority.js";
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
const triggerJob = (toolsAllow?: string[]) => ({
  trigger: { script: "return true" },
  payload: { ...wakePayload, ...(toolsAllow ? { toolsAllow } : {}) },
});
const stream = (extra = {}) => ({ kind: "stream", command: ["node", "events.mjs"], ...extra });

describe("cron tool creator cap", () => {
  it("distinguishes explicit stream creates from kindless stream update fields", () => {
    const malformedCreate = {
      schedule: { kind: "every", everyMs: 60_000, command: ["node", "events.mjs"] },
    };
    expect(cronCreateRequiresStreamExecAuthority(malformedCreate)).toBe(false);
    expect(cronMutationRequiresStreamExecAuthority(malformedCreate)).toBe(false);
    expect(
      cronMutationRequiresStreamExecAuthority({ schedule: { command: ["node", "events.mjs"] } }),
    ).toBe(true);
    expect(cronCreateRequiresStreamExecAuthority({ schedule: stream() })).toBe(true);
  });

  it("does not require stream authority for invalid command fields on an every schedule", () => {
    expect(
      cronUpdateRequiresStreamExecAuthority(
        { schedule: { command: ["node", "invalid-on-every.mjs"] } },
        { enabled: true, schedule: { kind: "every", everyMs: 60_000 } },
      ),
    ).toBe(false);
  });

  it("lets default agent turns follow their owner while scripts and Codex apps keep the creator's tools", () => {
    const scriptedJob = triggerJob();
    const agentJob = { payload: { ...agentPayload } };
    const codexAppJob = { payload: { ...agentPayload } };
    const plainJob = { payload: { ...wakePayload } };

    capCronJobToolsAllowOnCreate(scriptedJob, ["read", "cron"]);
    capCronJobToolsAllowOnCreate(agentJob, ["read", "cron"]);
    capCronJobToolsAllowOnCreate(codexAppJob, ["read", "cron"], true);
    capCronJobToolsAllowOnCreate(plainJob, ["read", "cron"]);

    // Legacy "cron" creator allowlists normalize to the canonical tool id.
    const creatorSnapshot = { toolsAllow: ["read", "automations"], toolsAllowIsDefault: true };
    expect(scriptedJob.payload).toEqual({ ...wakePayload, ...creatorSnapshot });
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
    expect(input).toEqual({ payload: { kind: "agentTurn", toolsAllow: ["read", "exec"] } });
  });

  it("leaves explicit narrower and default caps unchanged in message-only patches", () => {
    for (const isDefault of [false, true]) {
      const payload = {
        ...agentPayload,
        toolsAllow: ["read"],
        ...(isDefault ? { toolsAllowIsDefault: true } : {}),
      };
      const patch = readyPatch({
        patch: { payload: { message: "updated" } },
        creatorToolAllowlist: isDefault ? ["read", "cron"] : ["read", "exec", "cron"],
        currentJob: { payload },
      });
      expect(patch).toEqual({ payload: { kind: "agentTurn", message: "updated" } });
    }
  });

  const native = { name: "exec", execOrigin: "native" } as const;
  const direct = { name: "exec", execOrigin: "openclaw" } as const;
  const aliased = { ...direct, aliasName: "gateway_exec" };
  const pin = { host: "gateway", ask: "always" } as const;
  const makeAlias = (ask?: "always") => gatewayExecAlias(testTool("exec"), ask);
  const read = { name: "read" };
  const processTool = { name: "process" };
  const pinned = { ...aliased, execTarget: pin };
  const nativeTools = { canonicalToolNames: ["exec", "process"] };
  const pinnedNative = { ...native, execTarget: { host: "gateway" as const } };
  type CaptureCase = [
    string,
    AnyAgentTool[],
    CronCreatorToolAllowlistEntry[],
    Parameters<typeof capture>[1]?,
    { host: "gateway"; ask?: "always" }?,
  ];
  it.each<CaptureCase>([
    ["canonical alias", [makeAlias("always"), testTool("read")], [pinned, read], undefined, pin],
    ["unregistered literal", [testTool("gateway_exec")], [{ name: "gateway_exec" }]],
    ["later unpinned grant", [makeAlias(), testTool("exec")], [aliased]],
    ["earlier unpinned grant", [testTool("exec"), makeAlias()], [aliased]],
    ["alias beside native shell", [makeAlias("always")], [pinned, processTool], nativeTools, pin],
    [
      "attested native shell",
      [testTool("read")],
      [read, pinnedNative, processTool, { name: "web_fetch" }],
      {
        canonicalToolNames: ["exec", "process", "read", "web_fetch"],
        nativeExecTarget: { host: "gateway" },
      },
      { host: "gateway" },
    ],
    ["unattested native shell", [testTool("read")], [read, native, processTool], nativeTools],
    [
      "native attestation cannot pin OpenClaw",
      [testTool("exec")],
      [direct],
      { canonicalToolNames: ["exec"], nativeExecTarget: { host: "gateway" } },
    ],
    [
      "native question",
      [testTool("read")],
      [read, { name: "ask_user" }],
      { canonicalToolNames: ["read", "ask_user"] },
    ],
  ])("captures %s", (_name, tools, expected, options, target) => {
    const captured = capture(tools, options);
    expect(captured).toEqual(expected);
    expect(resolveCronCreatorExecToolTarget(captured)).toEqual(target);
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
    for (const tools of [
      [guarded, unguarded],
      [unguarded, guarded],
    ]) {
      expect(resolveCronCreatorExecToolTarget(capture(tools))).toEqual({ host: "gateway" });
    }
  });

  it("caps explicit alias-name requests to the canonical persisted tool id", () => {
    const alias = gatewayExecAlias(testTool("exec"));
    const creator = capture([alias, testTool("read")]);

    for (const requested of [["gateway_exec"], ["exec"], ["gateway_exec", "read"]]) {
      const job = triggerJob([...requested]);
      capCronJobToolsAllowOnCreate(job, creator);
      const expected = requested.includes("read") ? ["exec", "read"] : ["exec"];
      expect(job.payload.toolsAllow).toEqual(expected);
    }

    expect(() => capCronJobToolsAllowOnCreate(triggerJob(["write"]), creator)).toThrow(
      'Requested automation tool "write" cannot be carried',
    );
  });

  it("treats an alias-name finite request as already covered by creator authority", () => {
    const alias = gatewayExecAlias(testTool("exec"));
    const creator = capture([alias]);

    const job = triggerJob(["gateway_exec"]);
    expect(cronCreateRequiresCreatorAuthority(job, creator)).toBe(false);
    expect(cronCreateRequiresCreatorAuthority(triggerJob(["exec", "browser"]), creator)).toBe(true);
  });
});
