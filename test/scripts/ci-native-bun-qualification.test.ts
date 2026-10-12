import * as fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
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
  const write = (file: string, source = fixture.source) => {
    fs.mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
    fs.writeFileSync(path.join(cwd, file), source);
  };
  for (const file of [...fixture.tests, fixture.setup, fixture.helper]) {
    write(file);
  }
  return { cwd, write };
}

describe("native Bun qualification inspection", () => {
  it("reports all changed inputs even when shared setup invalidates every entry", () => {
    const { cwd, write } = qualifiedSource();
    write(fixture.setup, "// changed setup\n");
    write(fixture.tests[0], "// changed test\n");
    fs.unlinkSync(path.join(cwd, fixture.helper));

    expect(inspectNativeBunQualifications(cwd)).toEqual({
      staleEntries: fixture.tests,
      changedInputs: [
        { file: fixture.tests[0], reason: "changed" },
        { file: fixture.helper, reason: "unreadable" },
        { file: fixture.setup, reason: "changed" },
      ],
    });
  });

  it("reads shared and missing inputs only once and attributes a helper to both consumers", () => {
    const { cwd } = qualifiedSource();
    fs.unlinkSync(path.join(cwd, fixture.helper));
    const read = vi.mocked(fs.readFileSync);
    read.mockClear();

    expect(inspectNativeBunQualifications(cwd)).toEqual({
      staleEntries: fixture.tests.slice(1),
      changedInputs: [{ file: fixture.helper, reason: "unreadable" }],
    });
    const inputs = [...fixture.tests, fixture.setup, fixture.helper].map((file) =>
      path.join(cwd, file),
    );
    const reads = read.mock.calls.map(([file]) => file);
    expect(reads).toHaveLength(inputs.length);
    expect(reads).toEqual(expect.arrayContaining(inputs));
  });

  it("observes same-process test edits and repairs without retaining stale hashes", () => {
    const { cwd, write } = qualifiedSource();
    expect(inspectNativeBunQualifications(cwd)).toEqual({ staleEntries: [], changedInputs: [] });
    write(fixture.tests[0], "// changed test\n");
    expect(inspectNativeBunQualifications(cwd)).toEqual({
      staleEntries: [fixture.tests[0]],
      changedInputs: [{ file: fixture.tests[0], reason: "changed" }],
    });
    write(fixture.tests[0]);
    expect(inspectNativeBunQualifications(cwd)).toEqual({ staleEntries: [], changedInputs: [] });
  });

  it("stays silent and preserves the existing native-to-Vitest fallback", () => {
    const { cwd, write } = qualifiedSource();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const selection = {
      configs: ["test/vitest/vitest.unit-fast.config.ts"],
      includePatterns: [fixture.tests[0]],
    };
    inspectNativeBunQualifications(cwd);
    expect(resolveCiTestRuntimeSelections(selection, "bun-compatible", cwd)).toEqual([
      { runtime: "bun", engine: "bun-test", files: [fixture.tests[0]] },
    ]);
    write(fixture.tests[0], "// changed test\n");
    inspectNativeBunQualifications(cwd);
    expect(resolveCiTestRuntimeSelections(selection, "bun-compatible", cwd)).toEqual([
      { runtime: "bun", includePatterns: [fixture.tests[0]] },
    ]);
    expect(log).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });
});
