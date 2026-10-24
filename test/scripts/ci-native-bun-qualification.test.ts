import * as fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  inspectNativeBunQualifications,
  resolveCiTestRuntimeSelections,
} from "../../scripts/lib/ci-test-runtime.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

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

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, readFileSync: vi.fn(actual.readFileSync) };
});

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

function qualifiedSource() {
  const cwd = tempDirs.make("native-bun-qualification-");
  const files = [...fixture.tests, fixture.setup, fixture.helper];
  const write = (file: string, source = fixture.source) => {
    fs.mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
    fs.writeFileSync(path.join(cwd, file), source);
  };
  for (const file of files) {
    write(file);
  }
  const inspect = (
    staleEntries: readonly string[] = [],
    changedInputs: { file: string; reason: "changed" | "unreadable" }[] = [],
  ) => expect(inspectNativeBunQualifications(cwd)).toEqual({ staleEntries, changedInputs });
  return { cwd, write, inspect, files: files.map((file) => path.join(cwd, file)) };
}

it.each([false, true])(
  "reports and deduplicates helper drift with shared setup drift=%s",
  (sharedDrift) => {
    const { cwd, write, inspect, files } = qualifiedSource();
    if (sharedDrift) {
      write(fixture.setup, "// changed setup\n");
      write(fixture.tests[0], "// changed test\n");
    }
    fs.unlinkSync(path.join(cwd, fixture.helper));
    const read = vi.mocked(fs.readFileSync);
    read.mockClear();
    const changed = (file: string) => ({ file, reason: "changed" as const });
    inspect(sharedDrift ? fixture.tests : fixture.tests.slice(1), [
      ...(sharedDrift ? [changed(fixture.tests[0])] : []),
      { file: fixture.helper, reason: "unreadable" },
      ...(sharedDrift ? [changed(fixture.setup)] : []),
    ]);
    const reads = read.mock.calls.map(([file]) => file);
    expect(reads.map(String).toSorted()).toEqual(files.toSorted());
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

it.each(["bun-all", "dual-all"] as const)(
  "stays silent and preserves the native-to-Vitest fallback under %s",
  (policy) => {
    const { cwd, write } = qualifiedSource();
    const output = (["log", "error", "warn"] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation(() => {}),
    );
    const selection = {
      configs: ["test/vitest/vitest.unit-fast.config.ts"],
      includePatterns: [fixture.tests[0]],
    };
    const expectSelection = (bun: { runtime: "bun"; engine?: "bun-test"; files?: string[] }) =>
      expect(resolveCiTestRuntimeSelections(selection, policy, cwd)).toEqual([
        ...(policy === "dual-all" ? [{ runtime: "node" }] : []),
        bun,
      ]);
    inspectNativeBunQualifications(cwd);
    expectSelection({ runtime: "bun", engine: "bun-test", files: [fixture.tests[0]] });
    write(fixture.tests[0], "// changed test\n");
    inspectNativeBunQualifications(cwd);
    expectSelection({ runtime: "bun" });
    for (const spy of output) {
      expect(spy).not.toHaveBeenCalled();
    }
  },
);
