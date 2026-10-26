import * as fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { inspectNativeBunQualifications } from "../../scripts/lib/ci-test-runtime.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { fixtureFiles } from "./script-fixture-files.test-support.js";

const fixture = vi.hoisted(() => ({
  source: "export const qualified = true;\n",
  setup: "test/qualification-setup.ts",
  helper: "test/qualification-helper.ts",
  tests: [
    "packages/markdown-core/src/chunk-text.test.ts",
    "src/agents/embedded-agent-runner/run/compaction-timeout.test.ts",
    "src/utils/chunk-items.test.ts",
  ] as const,
}));

// mock-isolation: synthetic inputs must not inherit qualifications from the real checkout.
vi.mock("../../scripts/lib/ci-test-native-bun-qualification.json", async () => {
  const { createHash } = await import("node:crypto");
  const hash = createHash("sha256").update(fixture.source).digest("hex");
  return {
    default: {
      setup: { [fixture.setup]: hash },
      tests: Object.fromEntries(fixture.tests.toReversed().map((file) => [file, hash])),
      helpers: {
        [fixture.tests[1]]: { [fixture.helper]: hash },
        [fixture.tests[2]]: { [fixture.helper]: hash, [fixture.setup]: hash },
      },
    },
  };
});

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function qualifiedSource() {
  const cwd = tempDirs.make("native-bun-qualification-");
  const write = (file: string, source = fixture.source) => fixtureFiles(cwd).write(file, source);
  for (const file of [...fixture.tests, fixture.setup, fixture.helper]) {
    write(file);
  }
  const inspect = (
    staleEntries: readonly string[] = [],
    changedInputs: { file: string; reason: "changed" | "unreadable" }[] = [],
  ) => expect(inspectNativeBunQualifications(cwd)).toEqual({ staleEntries, changedInputs });
  return { cwd, write, inspect };
}

it.each([false, true])(
  "reports and deduplicates helper drift with shared setup drift=%s",
  (sharedDrift) => {
    const { cwd, write, inspect } = qualifiedSource();
    if (sharedDrift) {
      write(fixture.setup, "// changed setup\n");
      write(fixture.tests[0], "// changed test\n");
    }
    fs.unlinkSync(path.join(cwd, fixture.helper));
    const changed = (file: string) => ({ file, reason: "changed" as const });
    inspect(sharedDrift ? fixture.tests : fixture.tests.slice(1), [
      ...(sharedDrift ? [changed(fixture.tests[0])] : []),
      { file: fixture.helper, reason: "unreadable" },
      ...(sharedDrift ? [changed(fixture.setup)] : []),
    ]);
  },
);

it("observes same-process test edits and repairs without retaining stale hashes", () => {
  const { write, inspect } = qualifiedSource();
  inspect();
  write(fixture.tests[0], "// changed test\n");
  inspect([fixture.tests[0]], [{ file: fixture.tests[0], reason: "changed" }]);
  write(fixture.tests[0]);
  inspect();
});
