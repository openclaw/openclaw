import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
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

function fixture(files: string[]) {
  const cwd = tempDirs.make("openclaw-package-directories-");
  for (const file of files) {
    const absolute = path.join(cwd, file);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, "export {};\n");
  }
  const plan = (...args: string[]) => buildVitestRunPlans(args, cwd);
  return { cwd, plan, selected: (...args: string[]) => selectedFiles(plan(...args)) };
}

function selectedFiles(plans: ReturnType<typeof buildVitestRunPlans>): string[] {
  return plans.flatMap((plan) => plan.includePatterns ?? plan.forwardedArgs).toSorted();
}
function expectedPlan(owner: string, directory: string, watchMode = false) {
  return {
    config: `test/vitest/vitest.${owner}.config.ts`,
    forwardedArgs: [],
    includePatterns: [`${directory}/**/*.test.ts`],
    watchMode,
  };
}

it("routes mixed package owners once beside explicit boundary and E2E leaves", () => {
  const ordinary = "packages/example/src/value.test.ts";
  const e2e = "packages/gateway-client/src/example.e2e.test.ts";
  const files = [ordinary, fast, worker, markdown, gateway, protocol, boundary, e2e];
  const f = fixture(files);
  expect(f.selected("packages", boundary)).toEqual(files.filter((file) => file !== e2e).toSorted());
  const plans = f.plan("packages", gateway, boundary, e2e);

  expect(selectedFiles(plans)).toEqual(files.toSorted());
  expect(
    files.map((file) => plans.find((plan) => selectedFiles([plan]).includes(file))?.config),
  ).toEqual(
    [
      "unit",
      "unit-fast-isolated",
      "infra",
      "unit-fast",
      "gateway-client",
      "gateway-client",
      "infra",
      "e2e",
    ].map((owner) => `test/vitest/vitest.${owner}.config.ts`),
  );
  expect(plans.find((plan) => plan.config === "test/vitest/vitest.e2e.config.ts")).toMatchObject({
    forwardedArgs: [e2e],
  });
});

it.each(["relative", "absolute", "trailing slash", "watch", "glob"])(
  "keeps %s directory selection bounded",
  (spelling) => {
    const native = spelling === "watch" || spelling === "glob";
    const directory = native ? "packages/gateway-client" : "packages/example/src";
    const selected = [`${directory}/one.test.ts`, `${directory}/nested/two.test.ts`];
    const f = fixture([
      ...selected,
      "packages/example/other.test.ts",
      "packages/elsewhere/other.test.ts",
    ]);
    const target =
      spelling === "absolute"
        ? path.join(f.cwd, directory)
        : spelling === "trailing slash"
          ? `./${directory}/`
          : directory;
    const args =
      spelling === "watch"
        ? ["--watch", target]
        : [spelling === "glob" ? `${target}/**/*.test.ts` : target];
    const plans = f.plan(...args);
    if (native) {
      expect(plans).toEqual([expectedPlan("gateway-client", directory, spelling === "watch")]);
    } else {
      expect(selectedFiles(plans)).toEqual(selected.toSorted());
    }
  },
);

it("excludes opt-in files and prunes excluded trees, including explicit roots", () => {
  const directory = "packages/example";
  const selected = `${directory}/value.test.ts`;
  const excluded = ["node_modules", "vendor", "._private"].map((name) => `${directory}/${name}`);
  const f = fixture([
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

  expect(f.selected(directory)).toEqual([selected]);
  for (const root of excluded) {
    expect(f.selected(root)).toEqual([`${root}/**/*.test.ts`]);
  }
  const enumerated = reads.mock.calls.map(([root]) =>
    path.relative(f.cwd, String(root)).split(path.sep).join("/"),
  );
  expect(enumerated).toContain(directory);
  expect(
    enumerated.some((root) => excluded.some((excludedRoot) => root.startsWith(excludedRoot))),
  ).toBe(false);
});

it.each([{ included: [protocol] }, { included: [] }])(
  "narrows directory discoveries to inherited includes $included while retaining the explicit boundary",
  ({ included }) => {
    const { cwd } = fixture([fast, gateway, protocol, boundary]);
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

it.each([
  { target: "packages/empty", reason: "target-matched-no-test-files" },
  { target: "packages/missing", reason: "path-does-not-exist" },
])("keeps $target bounded and reports its missing tests", ({ target, reason }) => {
  const f = fixture(["packages/empty/README.md"]);
  expect(f.plan(target)).toEqual([expectedPlan("unit", target)]);
  expect(findUnmatchedExplicitTestTargets([target], f.cwd)).toEqual([
    expect.objectContaining({ target, reason }),
  ]);
});
