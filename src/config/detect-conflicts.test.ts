import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "./config.js";
import { detectConfigConflicts } from "./detect-conflicts.js";

describe("detectConfigConflicts", () => {
  it("returns no conflicts for default config", () => {
    const conflicts = detectConfigConflicts({} as OpenClawConfig);
    expect(conflicts).toEqual([]);
  });

  it("reports warning when exec ask is off and sandbox is active", () => {
    const conflicts = detectConfigConflicts({
      tools: { exec: { ask: "off" } },
      agents: { defaults: { sandbox: { mode: "non-main" } } },
    } as OpenClawConfig);

    expect(conflicts.some((entry) => entry.level === "warning" && entry.message.includes("tools.exec.ask"))).toBe(
      true,
    );
  });

  it("reports warning when elevated is enabled and sandbox is active", () => {
    const conflicts = detectConfigConflicts({
      tools: { elevated: { enabled: true } },
      agents: { defaults: { sandbox: { mode: "all" } } },
    } as OpenClawConfig);

    expect(
      conflicts.some(
        (entry) => entry.level === "warning" && entry.message.includes("tools.elevated.enabled"),
      ),
    ).toBe(true);
  });

  it("reports warning when exec host is gateway and sandbox is active", () => {
    const conflicts = detectConfigConflicts({
      tools: { exec: { host: "gateway" } },
      agents: { defaults: { sandbox: { mode: "all" } } },
    } as OpenClawConfig);

    expect(
      conflicts.some((entry) => entry.level === "warning" && entry.message.includes('tools.exec.host is "gateway"')),
    ).toBe(true);
  });

  it("reports critical conflict for exposed gateway without auth", () => {
    const conflicts = detectConfigConflicts({
      gateway: {
        bind: "lan",
        auth: { mode: "none" },
      },
    } as OpenClawConfig);

    expect(
      conflicts.some(
        (entry) => entry.level === "critical" && entry.message.includes('gateway.auth.mode is "none"'),
      ),
    ).toBe(true);
  });

  it("reports info for high-safety config profile", () => {
    const conflicts = detectConfigConflicts({
      agents: { defaults: { sandbox: { mode: "all" } } },
      tools: {
        exec: {
          ask: "always",
          host: "sandbox",
          security: "allowlist",
        },
      },
    } as OpenClawConfig);

    expect(conflicts.some((entry) => entry.level === "info")).toBe(true);
  });

  it("returns multiple conflicts when several risky combinations are configured", () => {
    const conflicts = detectConfigConflicts({
      agents: { defaults: { sandbox: { mode: "all" } } },
      tools: {
        exec: { ask: "off", host: "gateway" },
        elevated: { enabled: true },
      },
      gateway: {
        bind: "lan",
        auth: { mode: "none" },
      },
    } as OpenClawConfig);

    expect(conflicts).toHaveLength(4);
    expect(conflicts.filter((entry) => entry.level === "warning")).toHaveLength(3);
    expect(conflicts.filter((entry) => entry.level === "critical")).toHaveLength(1);
  });
});
