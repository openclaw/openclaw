import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { createCronScheduledToolProjection } from "../exec-tool-target-pinning.js";
import type { AnyAgentTool } from "./common.js";
import { replaceWithEffectiveCronCreatorToolAllowlist } from "./cron-tool-creator-cap.js";
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

describe("cron tool creator cap", () => {
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
  });

  it("captures an unregistered same-name tool literally, never as shell authority", () => {
    const colliding = testTool("gateway_exec");
    const target: CronCreatorToolAllowlistEntry[] = [];

    replaceWithEffectiveCronCreatorToolAllowlist(target, [colliding]);

    expect(target).toEqual([{ name: "gateway_exec" }]);
  });

  it("drops the restrict-only pin when a direct unpinned exec grant also exists", () => {
    const execTool = testTool("exec");
    const alias = gatewayExecAlias(testTool("exec"));
    const aliasFirst: CronCreatorToolAllowlistEntry[] = [];
    const directFirst: CronCreatorToolAllowlistEntry[] = [];

    replaceWithEffectiveCronCreatorToolAllowlist(aliasFirst, [alias, execTool]);
    replaceWithEffectiveCronCreatorToolAllowlist(directFirst, [execTool, alias]);

    expect(aliasFirst).toEqual([{ name: "exec", aliasName: "gateway_exec" }]);
    expect(directFirst).toEqual([{ name: "exec", aliasName: "gateway_exec" }]);
  });

  it("keeps a guarded gateway exec pin when the native harness also owns shell", () => {
    const target: CronCreatorToolAllowlistEntry[] = [];

    replaceWithEffectiveCronCreatorToolAllowlist(
      target,
      [gatewayExecAlias(testTool("exec"), "always")],
      undefined,
      { canonicalToolNames: ["exec", "process"] },
    );

    expect(target).toEqual([
      { name: "exec", aliasName: "gateway_exec", execTarget: { host: "gateway", ask: "always" } },
      { name: "process" },
    ]);
  });

  it("pins native shell authority to the gateway host only when the caller vouches for it", () => {
    const pinned: CronCreatorToolAllowlistEntry[] = [];
    const unpinned: CronCreatorToolAllowlistEntry[] = [];

    replaceWithEffectiveCronCreatorToolAllowlist(pinned, [testTool("read")], undefined, {
      canonicalToolNames: ["exec", "process", "read", "web_fetch"],
      nativeExecTarget: { host: "gateway" },
    });
    // A harness whose shell may run remotely (for example Codex on a node or
    // sandbox placement) records plain exec so host routing stays configurable.
    replaceWithEffectiveCronCreatorToolAllowlist(unpinned, [testTool("read")], undefined, {
      canonicalToolNames: ["exec", "process"],
    });

    expect(pinned).toEqual([
      { name: "read" },
      { name: "exec", execTarget: { host: "gateway" } },
      { name: "process" },
      { name: "web_fetch" },
    ]);
    expect(unpinned).toEqual([{ name: "read" }, { name: "exec" }, { name: "process" }]);
  });

  it("never pins a direct unpinned exec grant because the native shell also exists", () => {
    const target: CronCreatorToolAllowlistEntry[] = [];

    replaceWithEffectiveCronCreatorToolAllowlist(target, [testTool("exec")], undefined, {
      canonicalToolNames: ["exec"],
      nativeExecTarget: { host: "gateway" },
    });

    expect(target).toEqual([{ name: "exec" }]);
  });

  it("rejects a backend-projected name outside the native capability vocabulary", () => {
    for (const rejected of [
      "Bash",
      "READ",
      " exec ",
      "apply-patch",
      "gateway_exec",
      "browser",
      "",
      "*",
    ]) {
      const target: CronCreatorToolAllowlistEntry[] = [];
      expect(() =>
        replaceWithEffectiveCronCreatorToolAllowlist(target, [testTool("read")], undefined, {
          canonicalToolNames: ["read", rejected],
        }),
      ).toThrow(/non-canonical native capability/);
    }
  });

  it("keeps only restrictions shared by duplicate gateway aliases", () => {
    const guarded = gatewayExecAlias(testTool("exec"), "always");
    const unguarded = gatewayExecAlias(testTool("exec"));
    const guardedFirst: CronCreatorToolAllowlistEntry[] = [];
    const unguardedFirst: CronCreatorToolAllowlistEntry[] = [];

    replaceWithEffectiveCronCreatorToolAllowlist(guardedFirst, [guarded, unguarded]);
    replaceWithEffectiveCronCreatorToolAllowlist(unguardedFirst, [unguarded, guarded]);

    expect(guardedFirst).toEqual([
      { name: "exec", aliasName: "gateway_exec", execTarget: { host: "gateway" } },
    ]);
    expect(unguardedFirst).toEqual(guardedFirst);
  });
});
