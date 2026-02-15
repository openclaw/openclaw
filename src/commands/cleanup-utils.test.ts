import { describe, expect, test } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { buildCleanupPlan } from "./cleanup-utils.js";

describe("buildCleanupPlan", () => {
  test("resolves inside-state flags and workspace dirs", () => {
    const cfg = {
      agents: {
        defaults: { workspace: "/tmp/openclaw-workspace-1" },
        list: [{ workspace: "/tmp/openclaw-workspace-2" }],
      },
    };
    const plan = buildCleanupPlan({
      cfg: cfg as unknown as OpenClawConfig,
      stateDir: "/tmp/openclaw-state",
      configPath: "/tmp/openclaw-state/openclaw.json",
      oauthDir: "/tmp/openclaw-oauth",
    });

    expect(plan.configInsideState).toBe(true);
    expect(plan.oauthInsideState).toBe(false);
    expect(new Set(plan.workspaceDirs)).toEqual(
      new Set(["/tmp/openclaw-workspace-1", "/tmp/openclaw-workspace-2"]),
    );
  });
});
