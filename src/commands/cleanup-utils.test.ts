import path from "node:path";
import { describe, expect, test } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { buildCleanupPlan } from "./cleanup-utils.js";

describe("buildCleanupPlan", () => {
  test("resolves inside-state flags and workspace dirs", () => {
    const tmpRoot = path.join(path.parse(process.cwd()).root, "tmp");
    const cfg = {
      agents: {
        defaults: { workspace: path.join(tmpRoot, "openclaw-workspace-1") },
        list: [{ workspace: path.join(tmpRoot, "openclaw-workspace-2") }],
      },
    };
    const plan = buildCleanupPlan({
      cfg: cfg as unknown as OpenClawConfig,
      stateDir: path.join(tmpRoot, "openclaw-state"),
      configPath: path.join(tmpRoot, "openclaw-state", "openclaw.json"),
      oauthDir: path.join(tmpRoot, "openclaw-oauth"),
    });

    expect(plan.configInsideState).toBe(true);
    expect(plan.oauthInsideState).toBe(false);
    expect(new Set(plan.workspaceDirs)).toEqual(
      new Set([
        path.join(tmpRoot, "openclaw-workspace-1"),
        path.join(tmpRoot, "openclaw-workspace-2"),
      ]),
    );
  });
});
