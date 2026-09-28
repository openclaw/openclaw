import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runManagedCommand } from "../../scripts/lib/managed-child-process.mts";
import { prepareVitestRuntime } from "../../scripts/lib/vitest-build-prerequisites.mts";
import { resolveVitestRuntimeCliSelections } from "../../scripts/lib/vitest-runtime-selection.mts";

vi.mock("../../scripts/lib/managed-child-process.mts", () => ({
  runManagedCommand: vi.fn(),
}));

const config = "test/vitest/vitest.e2e.config.ts";
const file = "packages/ai/src/package.e2e.test.ts";
const env = { OPENCLAW_E2E_USE_PREBUILT_DIST: "1", OPENCLAW_RUN_NODE_SKIP_DTS_BUILD: "1" };
const packageRoot = path.resolve("packages/ai");

afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(runManagedCommand).mockReset();
});

describe("prebuilt AI package preparation", () => {
  it.each([false, true])("repairs missing declarations (partially built: %s)", async (partial) => {
    const selections = resolveVitestRuntimeCliSelections(config, ["run", file], env);
    vi.spyOn(fs, "readFileSync").mockReturnValue(
      JSON.stringify({
        types: "./dist/index.d.mts",
        exports: {
          ".": { types: "./dist/index.d.mts" },
          "./nested": { types: "./dist/nested.d.mts" },
        },
      }),
    );
    vi.spyOn(fs, "existsSync").mockImplementation(
      (entry) => partial && entry === path.join(packageRoot, "dist/index.d.mts"),
    );
    vi.mocked(runManagedCommand).mockResolvedValue(0);

    expect(await prepareVitestRuntime(selections, env)).toBe(0);
    expect(runManagedCommand).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        args: ["--import", "tsx", "scripts/tsdown-build.mts", "--config", "tsdown.ai.config.ts"],
        env: { ...env, OPENCLAW_RUN_NODE_SKIP_DTS_BUILD: "0" },
      }),
    );
  });

  it("reuses a package with all declared entries", async () => {
    const selections = resolveVitestRuntimeCliSelections(config, ["run", file], env);
    vi.spyOn(fs, "existsSync").mockReturnValue(true);
    expect(await prepareVitestRuntime(selections, env)).toBe(0);
    expect(runManagedCommand).not.toHaveBeenCalled();
  });

  it.each([
    ["unrelated E2E", ["run", "test/scripts/ci-prepared-runtime.e2e.test.ts"], env],
    ["excluded package", ["run", file, "--exclude", file], env],
    ["explicit skip", ["run", file], { ...env, OPENCLAW_E2E_SKIP_BUILD: "1" }],
    ["canonical setup", ["run", file], {}],
  ])("adds no build for %s", async (_name, args, commandEnv) => {
    const selections = resolveVitestRuntimeCliSelections(config, args, commandEnv);
    const read = vi.spyOn(fs, "readFileSync");
    expect(await prepareVitestRuntime(selections, commandEnv)).toBe(0);
    expect(read).not.toHaveBeenCalled();
    expect(runManagedCommand).not.toHaveBeenCalled();
  });

  it("propagates the typed build failure before admitting workers", async () => {
    const selections = resolveVitestRuntimeCliSelections(config, ["run", file], env);
    vi.spyOn(fs, "existsSync").mockReturnValue(false);
    vi.mocked(runManagedCommand).mockResolvedValue(23);
    expect(await prepareVitestRuntime(selections, env)).toBe(23);
  });
});
