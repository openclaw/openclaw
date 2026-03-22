import fs from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";

// Narrow public testing surface for plugin authors.
// Keep this list additive and limited to helpers we are willing to support.

export { removeAckReactionAfterReply, shouldAckReaction } from "../channels/ack-reactions.js";
export type { ChannelAccountSnapshot, ChannelGatewayContext } from "../channels/plugins/types.js";
export type { OpenClawConfig } from "../config/config.js";
export type { PluginRuntime } from "../plugins/runtime/types.js";
export type { OutputRuntimeEnv, RuntimeEnv } from "../runtime.js";
export type { MockFn } from "../test-utils/vitest-mock-fn.js";

/** Create a tiny Windows `.cmd` shim fixture for plugin tests that spawn CLIs. */
export async function createWindowsCmdShimFixture(params: {
  shimPath: string;
  scriptPath: string;
  shimLine: string;
}): Promise<void> {
  await fs.mkdir(path.dirname(params.scriptPath), { recursive: true });
  await fs.mkdir(path.dirname(params.shimPath), { recursive: true });
  await fs.writeFile(params.scriptPath, "module.exports = {};\n", "utf8");
  await fs.writeFile(params.shimPath, `@echo off\r\n${params.shimLine}\r\n`, "utf8");
}

type ResolveTargetMode = "explicit" | "implicit" | "heartbeat";

type ResolveTargetResult = {
  ok: boolean;
  to?: string;
  error?: unknown;
};

type ResolveTargetFn = (params: {
  to?: string;
  mode: ResolveTargetMode;
  allowFrom: string[];
}) => ResolveTargetResult;

/** Install a shared test matrix for target-resolution error handling. */
export function installCommonResolveTargetErrorCases(params: {
  resolveTarget: ResolveTargetFn;
  implicitAllowFrom: string[];
}) {
  const { resolveTarget, implicitAllowFrom } = params;

  it("should error on normalization failure with allowlist (implicit mode)", () => {
    const result = resolveTarget({
      to: "invalid-target",
      mode: "implicit",
      allowFrom: implicitAllowFrom,
    });

    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
  });

  it("should error when no target provided with allowlist", () => {
    const result = resolveTarget({
      to: undefined,
      mode: "implicit",
      allowFrom: implicitAllowFrom,
    });

    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
  });

  it("should error when no target and no allowlist", () => {
    const result = resolveTarget({
      to: undefined,
      mode: "explicit",
      allowFrom: [],
    });

    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
  });

  it("should handle whitespace-only target", () => {
    const result = resolveTarget({
      to: "   ",
      mode: "explicit",
      allowFrom: [],
    });

    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
  });
}
