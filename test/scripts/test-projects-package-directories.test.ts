import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildVitestRunPlans,
  createVitestRunSpecs,
  findUnmatchedExplicitTestTargets,
} from "../../scripts/test-projects.test-support.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

const fast = "packages/memory-host-sdk/src/host/batch-http.test.ts";
const worker = "packages/memory-host-sdk/src/host/session-memory-sync.test.ts";
const markdown = "packages/markdown-core/src/ir.test.ts";
const gateway = "packages/gateway-client/src/timeouts.test.ts";
const protocol = "packages/gateway-protocol/src/frame-guards.test.ts";
const boundary = "src/infra/fs-safe-import-boundary.test.ts";

function fixture(files: string[]): string {
  const cwd = tempDirs.make("openclaw-package-directories-");
  for (const file of files) {
    const absolute = path.join(cwd, file);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, "export {};\n");
  }
  return cwd;
}

function selectedFiles(plans: ReturnType<typeof buildVitestRunPlans>): string[] {
  return plans.flatMap((plan) => plan.includePatterns ?? plan.forwardedArgs).toSorted();
}

describe("package directory targets", () => {
  it("routes mixed package owners once beside an explicit boundary", () => {
    const ordinary = "packages/example/src/value.test.ts";
    const files = [ordinary, fast, worker, markdown, gateway, protocol, boundary];
    const cwd = fixture(files);
    const plans = buildVitestRunPlans(["packages", gateway, boundary], cwd);

    expect(selectedFiles(plans)).toEqual(files.toSorted());
    for (const [file, owner] of [
      [ordinary, "unit"],
      [fast, "unit-fast-isolated"],
      [worker, "infra"],
      [markdown, "unit-fast"],
      [gateway, "gateway-client"],
      [protocol, "gateway-client"],
      [boundary, "infra"],
    ] as const) {
      expect(plans.find((plan) => selectedFiles([plan]).includes(file))).toMatchObject({
        config: `test/vitest/vitest.${owner}.config.ts`,
      });
    }
  });

  it.each(["relative", "absolute", "trailing slash"])(
    "keeps a nested %s directory inside its requested subtree",
    (spelling) => {
      const directory = "packages/example/src";
      const selected = [`${directory}/one.test.ts`, `${directory}/nested/two.test.ts`];
      const cwd = fixture([
        ...selected,
        "packages/example/other.test.ts",
        "packages/elsewhere/other.test.ts",
      ]);
      const target =
        spelling === "absolute"
          ? path.join(cwd, directory)
          : spelling === "trailing slash"
            ? `./${directory}/`
            : directory;
      expect(selectedFiles(buildVitestRunPlans([target], cwd))).toEqual(selected.toSorted());
    },
  );

  it("excludes opt-in files and prunes excluded trees, including explicit roots", () => {
    const directory = "packages/example";
    const selected = `${directory}/value.test.ts`;
    const excluded = ["node_modules", "vendor", "._private"].map((name) => `${directory}/${name}`);
    const cwd = fixture([
      selected,
      ...excluded.map((root) => `${root}/hidden.test.ts`),
      ...[
        "value.live.test.ts",
        "value.e2e.test.ts",
        "._value.test.ts",
        "value.spec.ts",
        "value.test.js",
      ].map((name) => `${directory}/${name}`),
    ]);
    const reads = vi.spyOn(fs, "readdirSync");

    expect(selectedFiles(buildVitestRunPlans([directory], cwd))).toEqual([selected]);
    for (const root of excluded) {
      expect(selectedFiles(buildVitestRunPlans([root], cwd))).toEqual([`${root}/**/*.test.ts`]);
    }
    const enumerated = reads.mock.calls.map(([root]) =>
      path.relative(cwd, String(root)).split(path.sep).join("/"),
    );
    expect(enumerated).toContain(directory);
    expect(
      enumerated.some((root) => excluded.some((excludedRoot) => root.startsWith(excludedRoot))),
    ).toBe(false);
  });

  it.each([{ included: [protocol] }, { included: [] }])(
    "narrows directory discoveries to inherited includes $included while retaining the explicit boundary",
    ({ included }) => {
      const cwd = fixture([fast, gateway, protocol, boundary]);
      const includeFile = path.join(cwd, "includes.json");
      fs.writeFileSync(includeFile, JSON.stringify(included));
      const specs = createVitestRunSpecs(["packages", boundary], {
        cwd,
        baseEnv: { OPENCLAW_VITEST_INCLUDE_FILE: includeFile },
      });
      expect(specs.flatMap((spec) => spec.includePatterns ?? []).toSorted()).toEqual(
        [...included, boundary].toSorted(),
      );
      expect(fs.readFileSync(includeFile, "utf8")).toBe(JSON.stringify(included));
    },
  );

  it("retains a separately named E2E leaf without admitting it through the directory", () => {
    const e2e = "packages/gateway-client/src/example.e2e.test.ts";
    const cwd = fixture([gateway, e2e]);
    const plans = buildVitestRunPlans(["packages/gateway-client", e2e], cwd);
    expect(selectedFiles(plans)).toEqual([gateway, e2e].toSorted());
    expect(plans.find((plan) => plan.config === "test/vitest/vitest.e2e.config.ts")).toMatchObject({
      forwardedArgs: [e2e],
    });
  });

  it.each([
    { target: "packages/empty", reason: "target-matched-no-test-files" },
    { target: "packages/missing", reason: "path-does-not-exist" },
  ])("keeps $target bounded and reports its missing tests", ({ target, reason }) => {
    const cwd = fixture(["packages/empty/README.md"]);
    expect(buildVitestRunPlans([target], cwd)).toEqual([
      {
        config: "test/vitest/vitest.unit.config.ts",
        forwardedArgs: [],
        includePatterns: [`${target}/**/*.test.ts`],
        watchMode: false,
      },
    ]);
    expect(findUnmatchedExplicitTestTargets([target], cwd)).toEqual([
      expect.objectContaining({ target, reason }),
    ]);
  });

  it.each([
    { args: ["--watch", "packages/gateway-client"], watchMode: true },
    { args: ["packages/gateway-client/**/*.test.ts"], watchMode: false },
  ])("preserves the native directory/glob selection for $args", ({ args, watchMode }) => {
    const cwd = fixture([gateway]);
    expect(buildVitestRunPlans(args, cwd)).toEqual([
      {
        config: "test/vitest/vitest.gateway-client.config.ts",
        forwardedArgs: [],
        includePatterns: ["packages/gateway-client/**/*.test.ts"],
        watchMode,
      },
    ]);
  });
});
