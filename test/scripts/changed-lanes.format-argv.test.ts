import { expect, it } from "vitest";
import { detectChangedLanes } from "../../scripts/changed-lanes.mts";
import { createChangedCheckPlan } from "../../scripts/check-changed.mts";

it.each([false, true])(
  "keeps every formatter path within the argv budget (lintOnly=%s)",
  (lintOnly) => {
    const paths = Array.from(
      { length: 1_600 },
      (_, index) => `docs/${"long目录_".repeat(8)}file-${index} name's.md`,
    ).toSorted((left, right) => left.localeCompare(right));
    const commands = createChangedCheckPlan(detectChangedLanes(paths), {
      lintOnly,
    }).commands.filter((command) => command.args[0] === "format:check");

    expect(commands.length).toBeGreaterThan(1);
    expect(commands.flatMap((command) => command.args.slice(3))).toEqual(paths);
    for (const command of commands) {
      expect(command.args.slice(0, 3)).toEqual([
        "format:check",
        "--no-error-on-unmatched-pattern",
        "--",
      ]);
      expect(Buffer.byteLength(command.args.join(" "), "utf8")).toBeLessThanOrEqual(24 * 1024);
    }
  },
);
