import { describe, it, expect } from "vitest";
import { applySafetyPosture } from "./apply-safety-posture.js";
import type { OpenClawConfig } from "./types.openclaw.js";

describe("applySafetyPosture", () => {
  it("returns config unchanged when no safetyPosture preset", () => {
    const cfg: OpenClawConfig = { commands: {} } as OpenClawConfig;
    expect(applySafetyPosture(cfg)).toBe(cfg);
  });

  it("returns config unchanged when preset is undefined", () => {
    const cfg: OpenClawConfig = {
      commands: {},
      safetyPosture: {},
    } as OpenClawConfig;
    expect(applySafetyPosture(cfg)).toBe(cfg);
  });

  it("applies development preset: sandbox off, dmScope main", () => {
    const cfg = applySafetyPosture({
      commands: {},
      safetyPosture: { preset: "development" },
    } as OpenClawConfig);

    expect(cfg.agents?.defaults?.sandbox?.mode).toBe("off");
    expect(cfg.agents?.defaults?.sandbox?.workspaceAccess).toBe("rw");
    expect(cfg.session?.dmScope).toBe("main");
    expect(cfg._safetyPostureResolvedProfile).toBe("full");
  });

  it("applies balanced preset: sandbox non-main, dmScope per-channel-peer", () => {
    const cfg = applySafetyPosture({
      commands: {},
      safetyPosture: { preset: "balanced" },
    } as OpenClawConfig);

    expect(cfg.agents?.defaults?.sandbox?.mode).toBe("non-main");
    expect(cfg.agents?.defaults?.sandbox?.workspaceAccess).toBe("ro");
    expect(cfg.session?.dmScope).toBe("per-channel-peer");
    expect(cfg._safetyPostureResolvedProfile).toBe("limited");
  });

  it("applies strict preset: sandbox all, workspace none, memory disabled", () => {
    const cfg = applySafetyPosture({
      commands: {},
      safetyPosture: { preset: "strict" },
    } as OpenClawConfig);

    expect(cfg.agents?.defaults?.sandbox?.mode).toBe("all");
    expect(cfg.agents?.defaults?.sandbox?.workspaceAccess).toBe("none");
    expect(cfg.session?.dmScope).toBe("per-channel-peer");
    expect(cfg._safetyPostureResolvedProfile).toBe("public");
  });

  it("explicit config values override preset defaults", () => {
    const cfg = applySafetyPosture({
      commands: {},
      safetyPosture: { preset: "strict" },
      agents: {
        defaults: {
          sandbox: { mode: "non-main", workspaceAccess: "rw" },
        },
      },
      session: { dmScope: "main" },
    } as unknown as OpenClawConfig);

    // Explicit values should be preserved
    expect(cfg.agents?.defaults?.sandbox?.mode).toBe("non-main");
    expect(cfg.agents?.defaults?.sandbox?.workspaceAccess).toBe("rw");
    expect(cfg.session?.dmScope).toBe("main");
    // Profile still derived from preset
    expect(cfg._safetyPostureResolvedProfile).toBe("public");
  });

  it("agentProfile override takes precedence over preset default", () => {
    const cfg = applySafetyPosture({
      commands: {},
      safetyPosture: { preset: "development", agentProfile: "limited" },
    } as OpenClawConfig);

    expect(cfg._safetyPostureResolvedProfile).toBe("limited");
  });

  it("preserves existing config fields", () => {
    const cfg = applySafetyPosture({
      commands: { ownerDisplaySecret: "test" },
      safetyPosture: { preset: "balanced" },
      model: { default: "gpt-4" },
    } as unknown as OpenClawConfig);

    expect(cfg.commands).toEqual({ ownerDisplaySecret: "test" });
    expect((cfg as Record<string, unknown>).model).toEqual({ default: "gpt-4" });
  });
});
