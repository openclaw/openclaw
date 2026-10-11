import { expect, it } from "vitest";
import { detectChangedLanes } from "../../scripts/changed-lanes.mts";
import { createChangedCheckPlan } from "../../scripts/check-changed.mts";

it.each([false, true])(
  "keeps env-budget checks without widening source lint (changed lint config: %s)",
  (changedLintConfig) => {
    const source = "src/infra/gateway-state-owner.ts";
    const result = detectChangedLanes([
      source,
      "config/env-var-count-budget.txt",
      ...(changedLintConfig ? ["config/tsconfig/oxlint.core.json"] : []),
    ]);
    const { commands } = createChangedCheckPlan(result, {
      env: { PATH: "/usr/bin" },
      base: "HEAD",
    });

    // This entry owns both global source counting and the shrink-only budget check.
    expect(commands).toContainEqual(
      expect.objectContaining({ args: ["check:max-lines-ratchet", "--base", "HEAD"] }),
    );
    const lintCommands = commands.filter(
      (command) => command.args[0] === "lint:core" || command.args[0] === "scripts/run-oxlint.mjs",
    );
    expect(lintCommands.map((command) => command.args)).toEqual(
      changedLintConfig
        ? [["lint:core"]]
        : [["scripts/run-oxlint.mjs", "--tsconfig", "config/tsconfig/oxlint.core.json", source]],
    );
  },
);
