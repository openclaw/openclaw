import { defineConfig } from "vitest/config";
import { createScopedVitestConfig } from "./vitest.scoped-config.ts";

const PLAN_MODE_TEST_FILES = [
  "src/gateway/sessions-patch.test.ts",
  "src/gateway/sessions-patch.subagent-gate.test.ts",
  "src/auto-reply/reply/commands-plan.test.ts",
  "src/agents/plan-mode/integration.test.ts",
  "src/agents/plan-mode/plan-nudge-crons.test.ts",
  "src/agents/subagent-registry.steer-restart.test.ts",
  "src/cron/isolated-agent/run.plan-mode.test.ts",
  "ui/src/ui/chat/slash-command-executor.node.test.ts",
  "ui/src/ui/chat/plan-resume.node.test.ts",
  // chat.test.ts was deleted upstream and split into run-controls.test.ts +
  // tool-expansion-state.test.ts + grouped-render.test.ts (commit 92191d37e6).
  // The plan-mode coverage previously in chat.test.ts is exercised by the
  // adjacent plan-* tests below + the mode-switcher/plan-cards tests in
  // ui/src/ui/chat/.
  "ui/src/ui/views/plan-approval-inline.test.ts",
] as const;

const PLAN_MODE_COVERAGE_FILES = [
  "src/agents/plan-mode/plan-nudge-crons.ts",
  "src/auto-reply/reply/commands-plan.ts",
  "ui/src/ui/chat/plan-resume.ts",
  "ui/src/ui/views/plan-approval-inline.ts",
] as const;

export function createPlanModeVitestConfig(env: Record<string, string | undefined> = process.env) {
  const base = createScopedVitestConfig([...PLAN_MODE_TEST_FILES], {
    env,
    excludeUnitFastTests: false,
    name: "plan-mode-hardening",
    passWithNoTests: false,
  });
  return defineConfig({
    ...base,
    test: {
      ...base.test,
      maxWorkers: 1,
      fileParallelism: false,
      coverage: {
        provider: "v8",
        reporter: ["text", "json-summary", "lcov"],
        all: false,
        include: [...PLAN_MODE_COVERAGE_FILES],
        exclude: ["**/*.test.ts"],
        thresholds: {
          lines: 90,
          functions: 90,
          branches: 85,
          statements: 90,
        },
      },
    },
  });
}

export default createPlanModeVitestConfig();
