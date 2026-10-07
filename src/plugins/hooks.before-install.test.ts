import { expect, it, vi } from "vitest";
import { createHookRunner } from "./hooks.js";
import { createMockPluginRegistry } from "./hooks.test-fixtures.js";
import type { PluginHookBeforeInstallEvent } from "./types.js";

const event: PluginHookBeforeInstallEvent = {
  targetName: "demo-skill",
  targetType: "skill",
  sourcePath: "/tmp/demo-skill",
  sourcePathKind: "directory",
  origin: "openclaw-workspace",
  request: { kind: "skill-install", mode: "install" },
  builtinScan: { status: "ok", scannedFiles: 1, critical: 0, warn: 0, info: 0, findings: [] },
  skill: { installId: "deps" },
};
it("preserves findings in priority order and stops at the first install blocker", async () => {
  const first = {
    ruleId: "first",
    severity: "warn",
    file: "a.ts",
    line: 1,
    message: "first finding",
  } as const;
  const blocked = {
    ruleId: "blocker",
    severity: "critical",
    file: "block.ts",
    line: 3,
    message: "blocked finding",
  } as const;
  const skipped = vi.fn(() => ({ findings: [first] }));
  const runner = createHookRunner(
    createMockPluginRegistry([
      { hookName: "before_install", priority: 0, handler: skipped },
      {
        hookName: "before_install",
        priority: 50,
        handler: () => ({ findings: [blocked], block: true, blockReason: "policy blocked" }),
      },
      { hookName: "before_install", priority: 100, handler: () => ({ findings: [first] }) },
    ]),
  );
  await expect(
    runner.runBeforeInstall(event, {
      origin: "openclaw-workspace",
      targetType: "skill",
      requestKind: "skill-install",
    }),
  ).resolves.toEqual({ findings: [first, blocked], block: true, blockReason: "policy blocked" });
  expect(skipped).not.toHaveBeenCalled();
});
