import { describe, expect, it, vi } from "vitest";
import type { ConfigFileSnapshot, ConfigValidationIssue } from "../config/types.openclaw.js";
import {
  stripAllowedValueIssuesFromConfig,
  tryStartupConfigAllowedValueSelfHeal,
} from "./config-startup-heal.js";

function createSnapshot(params: {
  valid: boolean;
  resolved?: Record<string, unknown>;
  issues?: ConfigValidationIssue[];
}): ConfigFileSnapshot {
  const resolved = params.resolved ?? {};
  return {
    path: "/tmp/openclaw.json",
    exists: true,
    raw: JSON.stringify(resolved),
    parsed: resolved,
    resolved,
    valid: params.valid,
    config: resolved,
    issues: params.issues ?? [],
    warnings: [],
    legacyIssues: [],
  };
}

describe("stripAllowedValueIssuesFromConfig", () => {
  it("strips paths tied to allowed-values issues", () => {
    const config = {
      gateway: { mode: "remote", bind: "internet" },
      channels: { discord: { streaming: "full-on" } },
    };
    const issues: ConfigValidationIssue[] = [
      {
        path: "gateway.bind",
        message: "Invalid option",
        allowedValues: ["loopback", "lan", "tailnet", "auto", "custom"],
      },
      {
        path: "channels.discord.streaming",
        message: "Invalid option",
        allowedValues: ["off", "partial", "block", "progress"],
      },
    ];

    const result = stripAllowedValueIssuesFromConfig({
      config,
      issues,
    });

    expect(result.strippedPaths).toEqual(["channels.discord.streaming", "gateway.bind"]);
    expect(result.config).toEqual({
      gateway: { mode: "remote" },
    });
  });

  it("ignores issues without allowed values", () => {
    const config = { gateway: { bind: "internet" } };
    const issues: ConfigValidationIssue[] = [
      {
        path: "gateway.bind",
        message: "some other validation error",
      },
    ];

    const result = stripAllowedValueIssuesFromConfig({
      config,
      issues,
    });

    expect(result.strippedPaths).toEqual([]);
    expect(result.config).toEqual(config);
  });

  it("strips array entries by index when allowed-values issues target arrays", () => {
    const config = {
      channels: {
        telegram: {
          accounts: [
            { id: "a", mode: "bad" },
            { id: "b", mode: "bad" },
            { id: "c", mode: "ok" },
          ],
        },
      },
    };
    const issues: ConfigValidationIssue[] = [
      {
        path: "channels.telegram.accounts.0.mode",
        message: "Invalid option",
        allowedValues: ["thread", "top-level"],
      },
      {
        path: "channels.telegram.accounts.1.mode",
        message: "Invalid option",
        allowedValues: ["thread", "top-level"],
      },
    ];

    const result = stripAllowedValueIssuesFromConfig({
      config,
      issues,
    });

    expect(result.strippedPaths).toEqual([
      "channels.telegram.accounts.0.mode",
      "channels.telegram.accounts.1.mode",
    ]);
    expect(result.config).toEqual({
      channels: {
        telegram: {
          accounts: [{ id: "a" }, { id: "b" }, { id: "c", mode: "ok" }],
        },
      },
    });
  });
});

describe("tryStartupConfigAllowedValueSelfHeal", () => {
  it("writes healed config and reloads snapshot when enum issues are strip-repairable", async () => {
    const invalidSnapshot = createSnapshot({
      valid: false,
      resolved: { gateway: { bind: "internet", mode: "local" } },
      issues: [
        {
          path: "gateway.bind",
          message: "Invalid option",
          allowedValues: ["loopback", "lan", "tailnet", "auto", "custom"],
        },
      ],
    });
    const healedSnapshot = createSnapshot({
      valid: true,
      resolved: { gateway: { mode: "local" } },
    });

    const writeConfig = vi.fn(async () => {});
    const readSnapshot = vi.fn(async () => healedSnapshot);
    const logWarn = vi.fn();

    const result = await tryStartupConfigAllowedValueSelfHeal({
      snapshot: invalidSnapshot,
      writeConfig,
      readSnapshot,
      logWarn,
    });

    expect(writeConfig).toHaveBeenCalledTimes(1);
    expect(writeConfig).toHaveBeenCalledWith({ gateway: { mode: "local" } });
    expect(readSnapshot).toHaveBeenCalledTimes(1);
    expect(result).toBe(healedSnapshot);
    expect(logWarn).toHaveBeenCalledWith(
      "gateway: stripped invalid config enum paths during startup: gateway.bind",
    );
  });

  it("returns original snapshot when no allowed-values paths are present", async () => {
    const invalidSnapshot = createSnapshot({
      valid: false,
      resolved: { gateway: { bind: "internet", mode: "local" } },
      issues: [{ path: "gateway.bind", message: "wrong type" }],
    });

    const writeConfig = vi.fn(async () => {});
    const readSnapshot = vi.fn(async () => invalidSnapshot);
    const logWarn = vi.fn();

    const result = await tryStartupConfigAllowedValueSelfHeal({
      snapshot: invalidSnapshot,
      writeConfig,
      readSnapshot,
      logWarn,
    });

    expect(result).toBe(invalidSnapshot);
    expect(writeConfig).not.toHaveBeenCalled();
    expect(readSnapshot).not.toHaveBeenCalled();
    expect(logWarn).not.toHaveBeenCalled();
  });

  it("keeps original snapshot when write fails", async () => {
    const invalidSnapshot = createSnapshot({
      valid: false,
      resolved: { gateway: { bind: "internet", mode: "local" } },
      issues: [
        {
          path: "gateway.bind",
          message: "Invalid option",
          allowedValues: ["loopback", "lan", "tailnet", "auto", "custom"],
        },
      ],
    });
    const writeConfig = vi.fn(async () => {
      throw new Error("boom");
    });
    const readSnapshot = vi.fn(async () => invalidSnapshot);
    const logWarn = vi.fn();

    const result = await tryStartupConfigAllowedValueSelfHeal({
      snapshot: invalidSnapshot,
      writeConfig,
      readSnapshot,
      logWarn,
    });

    expect(result).toBe(invalidSnapshot);
    expect(writeConfig).toHaveBeenCalledTimes(1);
    expect(readSnapshot).not.toHaveBeenCalled();
    expect(logWarn).toHaveBeenCalledWith(
      "gateway: startup enum self-heal failed while stripping invalid config paths (gateway.bind): Error: boom",
    );
  });
});
