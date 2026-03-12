import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { resolveThreadBindingSpawnPolicy } from "./thread-bindings-policy.js";

const baseCfg = {
  session: { mainKey: "main", scope: "per-sender" },
} satisfies OpenClawConfig;

describe("resolveThreadBindingSpawnPolicy", () => {
  it("defaults thread-bound spawns to opt-in across supported channels", () => {
    expect(
      resolveThreadBindingSpawnPolicy({
        cfg: baseCfg,
        channel: "discord",
        kind: "subagent",
      }).spawnEnabled,
    ).toBe(false);
    expect(
      resolveThreadBindingSpawnPolicy({
        cfg: baseCfg,
        channel: "matrix",
        kind: "subagent",
      }).spawnEnabled,
    ).toBe(false);
    expect(
      resolveThreadBindingSpawnPolicy({
        cfg: baseCfg,
        channel: "telegram",
        kind: "acp",
      }).spawnEnabled,
    ).toBe(false);
  });

  it("honors explicit per-channel spawn flags", () => {
    const cfg = {
      ...baseCfg,
      channels: {
        matrix: {
          threadBindings: {
            spawnSubagentSessions: true,
            spawnAcpSessions: true,
          },
        },
      },
    } satisfies OpenClawConfig;

    expect(
      resolveThreadBindingSpawnPolicy({
        cfg,
        channel: "matrix",
        kind: "subagent",
      }).spawnEnabled,
    ).toBe(true);
    expect(
      resolveThreadBindingSpawnPolicy({
        cfg,
        channel: "matrix",
        kind: "acp",
      }).spawnEnabled,
    ).toBe(true);
  });
});
