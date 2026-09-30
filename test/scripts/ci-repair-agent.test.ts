import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildCandidateEnv,
  canonicalFailure,
  classifyJob,
  dependencyInputsChanged,
  escapeMarkdown,
  guardPatch,
  isInfraOnly,
  main,
  parseFailures,
  parseResult,
  patchSha256,
  renderPrBody,
} from "../../scripts/ci-repair-agent.mts";

const result = parseResult({
  action: "fix",
  patch: patch(),
  failingTests: ["src/example.test.ts"],
  cause: "restore fixture cleanup",
  classification: "flake",
  evidence: "The fixture retained shared state between tests.",
  confidence: "high",
});
vi.mock("node:child_process", () => ({ execFileSync: vi.fn(), spawnSync: vi.fn() }));
vi.mock("node:fs", () => ({
  appendFileSync: vi.fn(),
  existsSync: vi.fn(),
  lstatSync: () => ({ isFile: () => true, isSymbolicLink: () => false, size: 100 }),
  mkdirSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
}));
afterEach(() => {
  vi.resetAllMocks();
  vi.unstubAllEnvs();
});
describe("rebased dependency proof", () => {
  it.each([
    "pnpm-lock.yaml",
    "package.json",
    "extensions/chat/package.json",
    "pnpm-workspace.yaml",
    ".npmrc",
    "extensions/chat/.npmrc",
    "patches/library.patch",
    "patches/nested/library.patch",
  ])("requires a refresh for changed dependency input %s", (path) => {
    expect(dependencyInputsChanged(["src/example.ts", path])).toBe(true);
  });
  it("does not refresh for unchanged inputs or unrelated source changes", () => {
    expect(dependencyInputsChanged([])).toBe(false);
    expect(
      dependencyInputsChanged(["src/example.ts", "src/example.test.ts", "docs/package.json.md"]),
    ).toBe(false);
  });
  it.each([
    { changed: "pnpm-lock.yaml", installExit: 0 },
    { changed: "src/example.ts", installExit: 0 },
    { changed: "pnpm-lock.yaml", installExit: 1 },
    { changed: "pnpm-lock.yaml", installExit: 124 },
  ])(
    "refreshes before proof and stops on installation failure: %j",
    async ({ changed, installExit }) => {
      vi.stubEnv("CI_GIT_OWNER", "/synthetic/git-owner.py");
      vi.stubEnv("GITHUB_OUTPUT", "/synthetic/output");
      vi.stubEnv("GH_TOKEN", "synthetic");
      const failedSha = "a".repeat(40);
      const commands: string[] = [];
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockImplementation((path) => {
        switch (String(path).split("/").at(-1)) {
          case "context.json":
            return JSON.stringify({
              run: { id: 123, attempt: 1, sha: failedSha },
              tests: [
                { file: "src/example.test.ts", reproduction: "reproduced", previousFailures: [] },
              ],
            });
          case "result.json":
            return JSON.stringify(result);
          case "repair-base.json":
            return JSON.stringify({ base: "b".repeat(40) });
          case "repair.patch":
            return patch();
          default:
            throw new Error("Unexpected artifact");
        }
      });
      vi.mocked(execFileSync).mockImplementation((_program, args) => {
        if (args?.includes(failedSha)) {
          expect(args.slice(args.indexOf("diff"))).toEqual([
            "diff",
            "--no-renames",
            "--name-only",
            "-z",
            failedSha,
            "HEAD",
            "--",
          ]);
          return `${changed}\0`;
        }
        return args?.includes("format-patch") ? patch() : "";
      });
      vi.mocked(spawnSync).mockImplementation((program, args, options) => {
        const installing = args?.includes("install") ?? false;
        commands.push(installing ? "install" : "test");
        expect(options?.env).toEqual(buildCandidateEnv(process.env));
        if (installing) {
          expect(program).toBe("timeout");
          expect(args).toEqual([
            "--signal=TERM",
            "--kill-after=15s",
            "600s",
            "pnpm",
            "install",
            "--frozen-lockfile",
          ]);
        }
        return {
          pid: 1,
          output: [],
          stdout: Buffer.alloc(0),
          stderr: Buffer.alloc(0),
          status: installing ? installExit : 0,
          signal: null,
        };
      });
      const previousExitCode = process.exitCode;
      try {
        await main(["prove"]);
        expect(commands).toEqual(
          changed === "src/example.ts"
            ? ["test"]
            : installExit === 0
              ? ["install", "test"]
              : ["install"],
        );
        const saves = vi.mocked(writeFileSync).mock.calls;
        expect(saves.some(([path]) => String(path).endsWith("publish-request.json"))).toBe(
          installExit === 0,
        );
        expect(
          vi
            .mocked(appendFileSync)
            .mock.calls.some(([, data]) => data === "publish_request=true\n"),
        ).toBe(installExit === 0);
        const proof = saves.filter(([path]) => String(path).endsWith("prove.log")).at(-1)?.[1];
        expect(proof).toContain(
          changed === "src/example.ts"
            ? "Dependency refresh not needed"
            : installExit === 0
              ? "Dependencies refreshed"
              : "Dependency refresh failed; no publication",
        );
        if (installExit !== 0) {
          expect(proof).toContain(`exit=${installExit}`);
          expect(process.exitCode).toBe(1);
        }
      } finally {
        process.exitCode = previousExitCode;
      }
    },
  );
});

describe("structured patch result", () => {
  it("accepts a fix diff and an empty diagnosis", () => {
    expect(parseResult(result).patch).toBe(patch());
    expect(parseResult({ ...result, action: "diagnose", patch: "" }).patch).toBe("");
  });
  it.each([undefined, null, 123, {}, [], "", " ", "x".repeat(256 * 1024 + 1)])(
    "rejects invalid fix patch shape (%#)",
    (value) => expect(() => parseResult({ ...result, patch: value })).toThrow(),
  );
  it("rejects a diagnosis carrying a patch", () => {
    expect(() => parseResult({ ...result, action: "diagnose" })).toThrow();
  });
});

describe("controller patch application", () => {
  function setup(value: unknown = result) {
    vi.stubEnv("CI_GIT_OWNER", "/synthetic/git-owner.py");
    vi.stubEnv("GITHUB_OUTPUT", "/synthetic/output");
    vi.mocked(readFileSync).mockImplementation((path) =>
      String(path).endsWith("result.json")
        ? JSON.stringify(value)
        : JSON.stringify({
            run: { id: 123, attempt: 1, sha: "a".repeat(40) },
            tests: [
              { file: "src/example.test.ts", reproduction: "reproduced", previousFailures: [] },
            ],
          }),
    );
  }
  function recordedVerdict() {
    const saved = vi
      .mocked(writeFileSync)
      .mock.calls.find(([path]) => String(path).endsWith("guard.json"));
    const data = saved?.[1];
    if (typeof data !== "string") {
      throw new Error("Missing guard verdict");
    }
    return JSON.parse(data);
  }
  it.each([
    { ...result, patch: undefined },
    { ...result, action: "diagnose", patch: "" },
    { ...result, patch: patch("baseline.json") },
    { ...result, patch: "not a diff" },
  ])("records rejected output without invoking Git (%#)", async (value) => {
    setup(value);
    await main(["guard"]);
    expect(recordedVerdict().passed).toBe(false);
    expect(execFileSync).not.toHaveBeenCalled();
    expect(appendFileSync).toHaveBeenCalledWith("/synthetic/output", "passed=false\n");
  });
  it.each(["check", "apply"])("records an unappliable patch when %s fails", async (failure) => {
    setup();
    vi.mocked(execFileSync).mockImplementation((_program, args) => {
      if (failure === "check" || !args?.includes("--check")) {
        throw new Error("synthetic Git failure");
      }
      return "";
    });
    await main(["guard"]);
    expect(recordedVerdict()).toMatchObject({
      passed: false,
      reasons: ["Patch does not apply cleanly to the candidate checkout"],
    });
    expect(execFileSync).toHaveBeenCalledTimes(failure === "check" ? 1 : 2);
    expect(appendFileSync).toHaveBeenCalledWith("/synthetic/output", "passed=false\n");
  });
  it.each([false, true])(
    "checks and applies before enforcing the working-tree guard (forbidden=%s)",
    async (forbidden) => {
      setup();
      const commands: string[][] = [];
      vi.mocked(execFileSync).mockImplementation((_program, args) => {
        if (!args) {
          throw new Error("Missing Git arguments");
        }
        commands.push([...args]);
        if (args.includes("rev-parse")) {
          return "a".repeat(40);
        }
        if (args.includes("--full-index")) {
          return patch(forbidden ? "baseline.json" : undefined);
        }
        return "";
      });
      await main(["guard"]);
      expect(commands.slice(0, 2).map((args) => args.slice(args.indexOf("apply")))).toEqual([
        ["apply", "--check", expect.stringMatching(/proposed\.patch$/)],
        ["apply", expect.stringMatching(/proposed\.patch$/)],
      ]);
      expect(commands.every((args) => args.includes("core.hooksPath=/dev/null"))).toBe(true);
      expect(recordedVerdict().passed).toBe(!forbidden);
      expect(appendFileSync).toHaveBeenCalledWith("/synthetic/output", `passed=${!forbidden}\n`);
    },
  );
});
function patch(
  path = "src/example.test.ts",
  before = "const value = stale;",
  after = "const value = fresh;",
) {
  const removed = before.split("\n");
  const added = after.split("\n");
  return `diff --git a/${path} b/${path}\nindex abc1234..def5678 100644\n--- a/${path}\n+++ b/${path}\n@@ -1,${removed.length} +1,${added.length} @@\n${removed.map((line) => `-${line}`).join("\n")}\n${added.map((line) => `+${line}`).join("\n")}\n`;
}
const job = (name: string, steps: string[]) => ({
  id: 1,
  name,
  conclusion: "failure",
  steps: steps.map((stepName) => ({ name: stepName, conclusion: "failure" })),
});

it("removes Actions control channels and credentials from candidate children without mutating the parent", () => {
  const parent = Object.freeze({
    PATH: "/synthetic/bin",
    HOME: "/synthetic/home",
    CI: "true",
    GITHUB_RUN_ID: "123",
    GITHUB_OUTPUT: "/synthetic/output",
    GITHUB_ENV: "/synthetic/env",
    GITHUB_PATH: "/synthetic/path",
    GITHUB_STATE: "/synthetic/state",
    GITHUB_STEP_SUMMARY: "/synthetic/summary",
    ACTIONS_RUNTIME_TOKEN: "synthetic",
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: "synthetic",
    ACTIONS_ID_TOKEN_REQUEST_URL: "https://example.invalid/oidc",
    ACTIONS_CACHE_URL: "https://example.invalid/cache",
    ACTIONS_RESULTS_URL: "https://example.invalid/results",
    GH_TOKEN: "synthetic",
    GITHUB_TOKEN: "synthetic",
    CI_REPAIR_READ_TOKEN: "synthetic",
  });
  expect(buildCandidateEnv(parent)).toEqual({
    PATH: "/synthetic/bin",
    HOME: "/synthetic/home",
    CI: "true",
    GITHUB_RUN_ID: "123",
  });
  expect(parent.GITHUB_OUTPUT).toBe("/synthetic/output");
  expect(parent.CI_REPAIR_READ_TOKEN).toBe("synthetic");
});

describe("failure collection", () => {
  it("extracts unique Vitest and annotation test paths without turning diagnostics into arguments", () => {
    expect(
      parseFailures(
        [
          "2026-09-26T01:00:00Z \u001b[31m FAIL \u001b[0m [unit] src/example.test.ts > cleanup",
          " FAIL  |tooling| src/example.test.ts > another case",
          "2026-09-26T01:00:00Z [shard:core] FAIL   tooling  src/example.test.ts > bare label",
          "::error file=extensions/chat/send.spec.ts,line=12::AssertionError",
          "::error title=Failure,file=ui/src/editor.test.ts::Failed",
          "::error file=src/runtime.ts,line=2::Type error",
          " FAIL ../escape.test.ts",
          " FAIL /tmp/foreign.test.ts",
          " FAIL --config=evil.test.ts",
        ].join("\n"),
      ),
    ).toEqual(["extensions/chat/send.spec.ts", "src/example.test.ts", "ui/src/editor.test.ts"]);
  });
  it.each(["Run hosted core test-types stripe", "Test types"])(
    "does not treat %s as runtime test execution",
    (step) => {
      expect(classifyJob(job("check-test-types", [step]))).toBe("unknown");
    },
  );
  it("skips infrastructure-only failures, retaining test and unknown failures", () => {
    const setup = job("node", ["Install dependencies"]);
    const aggregate = job("openclaw/ci-gate", ["Verify selected CI lanes"]);
    expect(isInfraOnly([setup, aggregate])).toBe(true);
    expect(isInfraOnly([job("unassigned runner", [])])).toBe(true);
    expect(isInfraOnly([])).toBe(false);
    expect(isInfraOnly([setup, job("node", ["Test Node suites"])])).toBe(false);
    expect(isInfraOnly([job("lint", ["Check types"])])).toBe(false);
    expect(classifyJob(setup, ["src/example.test.ts"])).toBe("tests");
  });
});

describe("patch-only publication guard", () => {
  it("accepts an ordinary single-commit patch and validates its digest", () => {
    const text = `From ${"a".repeat(40)} Mon Sep 17 00:00:00 2001\nFrom: Example <example@example.com>\nSubject: [PATCH] fix(test): cleanup\n\n---\n${patch()}`;
    expect(guardPatch(text, result, patchSha256(text))).toEqual({
      passed: true,
      reasons: [],
      files: ["src/example.test.ts"],
      changedLines: 2,
    });
    expect(guardPatch(text, result, "0".repeat(64)).reasons).toContain("Patch sha256 mismatch");
  });
  it.each([
    ".github/workflows/ci.yml",
    "package.json",
    "extensions/chat/package.json",
    "pnpm-lock.yaml",
    "tsconfig.json",
    "test/tsconfig/tsconfig.test.root.json",
    "pnpm-workspace.yaml",
    ".npmrc",
    "extensions/chat/.npmrc",
    ".gitattributes",
    ".gitmodules",
    ".gitignore",
    "ui/.eslintignore",
    "test/.prettierignore",
    ".dockerignore",
    ".ignore",
    "patches/library.patch",
    "src/example.snap",
    "test/__snapshots__/example.ts",
    "baseline.json",
    "scripts/assertion-ratchet.json",
    "src/plugin-inventory.ts",
    "CHANGELOG.md",
    "CHANGELOG/2026.md",
    "test/vitest/setup.ts",
    "vitest.config.ts",
    "config/vitest.unit.config.ts",
    "dist/index.js",
    "src/example.generated.ts",
    "generated/index.ts",
    "scripts/ci-repair-agent.mts",
    "AGENTS.md",
  ])("rejects forbidden path %s", (path) => {
    expect(guardPatch(patch(path), result).passed).toBe(false);
  });
  it.each([
    "test.skip('case', fn);",
    "it.only('case', fn);",
    "describe.todo('case');",
    "test.fails('case', fn);",
    "test . skip('case', fn);",
    "test['only']('case', fn);",
    "const options = { retry: 2 };",
    "const options = { retries: 2 };",
    "testTimeout: 30000,",
    "hookTimeout: 10000,",
    "vi.setConfig({});",
    "// @ts-nocheck",
    "// @ts-ignore",
    "// @ts-expect-error",
    "// eslint-disable-next-line",
    "/* oxlint-disable */",
  ])("rejects coverage-weakening addition %s", (line) => {
    expect(guardPatch(patch(undefined, "const value = 1;", line), result).reasons).toContain(
      "Forbidden added pattern: src/example.test.ts",
    );
  });
  it.each([
    "test.skipIf(flag)('case', fn);",
    "test.runIf(flag)('case', fn);",
    "it.skipIf(flag)('case', fn);",
    "it.runIf(flag)('case', fn);",
    "describe.skipIf(flag)('suite', fn);",
    "describe.runIf(flag)('suite', fn);",
    "bench.skipIf(flag)('case', fn);",
    "bench.runIf(flag)('case', fn);",
    "it['skipIf'](flag)('case', fn);",
    "test . runIf (flag)('case', fn);",
    "it('case', { skip: true }, fn);",
    "test('case', fn, { only: true });",
    "describe('suite', { todo: true }, fn);",
    "it('case', { fails: true }, fn);",
    "test('case', { timeout: 30_000 }, fn);",
    "test('case', { retry: 2 }, fn);",
    "describe('suite', { repeats: 2 }, fn);",
    ...["skip", "only", "todo", "fails", "timeout", "retry", "repeats"].flatMap((key) => [
      `const options = { "${key}": true };`,
      `const options = { '${key}': true };`,
      `const options = { ["${key}"]: true };`,
      `const options = { ['${key}']: true };`,
      `const options = { [\`${key}\`]: true };`,
    ]),
    "  timeout: 30_000,",
    "it('case', fn, 30000);",
    "test('case', fn, 30_000);",
    "describe('suite', fn, 3e4);",
    "}, 30000)",
    ", 30_000)",
    "it('case', fn, 30_000,);",
    "test('case', fn, 0x7530);",
    "describe('suite', fn, 30_000.0);",
  ])("rejects added Vitest controls in test files: %s", (line) => {
    expect(guardPatch(patch("src/example.test.ts", "const value = 1;", line), result).passed).toBe(
      false,
    );
  });
  it.each([
    "src/example.test.ts",
    "extensions/chat/send.spec.ts",
    "ui/src/editor.spec.tsx",
    "ui/src/e2e/example.e2e.test.ts",
    "src/example.test-support.ts",
    "src/test-utils/fixture.ts",
    "src/example.test-harness.ts",
    "test/helpers/fixture.ts",
    "extensions/example/test/fixture.ts",
  ])("applies test-control rules to %s", (path) => {
    expect(
      guardPatch(patch(path, "const options = {};", "const options = { timeout: 30000 };"), result)
        .passed,
    ).toBe(false);
  });
  it("keeps ordinary timeout options allowed in product code", () => {
    expect(
      guardPatch(
        patch("src/client.ts", "const options = {};", "const options = { timeout: 30000 };"),
        result,
      ).passed,
    ).toBe(true);
    expect(
      guardPatch(
        patch("src/client.ts", "const options = {};", 'const options = { "timeout": 30000 };'),
        result,
      ).passed,
    ).toBe(true);
    expect(
      guardPatch(patch("src/client.ts", "const value = 1;", "test.skip('case', fn);"), result)
        .passed,
    ).toBe(false);
  });
  it("enforces file and changed-line budgets at their boundaries", () => {
    expect(
      guardPatch([1, 2, 3, 4].map((i) => patch(`src/file${i}.ts`)).join(""), result).passed,
    ).toBe(true);
    expect(
      guardPatch([1, 2, 3, 4, 5].map((i) => patch(`src/file${i}.ts`)).join(""), result).reasons,
    ).toContain("Patch must modify 1–4 files");
    expect(
      guardPatch(
        patch(
          undefined,
          Array(40).fill("old();").join("\n"),
          Array(40).fill("newValue();").join("\n"),
        ),
        result,
      ).passed,
    ).toBe(true);
    expect(
      guardPatch(
        patch(
          undefined,
          Array(40).fill("old();").join("\n"),
          Array(41).fill("newValue();").join("\n"),
        ),
        result,
      ).reasons,
    ).toContain("Patch must change 1–80 lines");
  });
  it.each([
    "expect(value).toEqual(1);",
    "expect (value).toEqual(1);",
    "assert(value);",
    "assert.equal(value, 1);",
  ])("rejects assertion loss: %s", (assertion) => {
    expect(guardPatch(patch(undefined, assertion, "value();"), result).reasons).toContain(
      "Assertion count decreased: src/example.test.ts",
    );
  });
  it("does not offset assertion loss by adding assertions in another file", () => {
    expect(
      guardPatch(
        patch(undefined, "expect(value).toBe(1);", "value();") +
          patch("src/other.test.ts", "value();", "expect(value).toBe(1);"),
        result,
      ).passed,
    ).toBe(false);
  });
  it.each([
    "diff --git a/src/a.ts b/src/b.ts\nsimilarity index 100%\nrename from src/a.ts\nrename to src/b.ts\n",
    "diff --git a/src/a.ts b/src/a.ts\nnew file mode 100644\nindex 0000000..1234567\n--- /dev/null\n+++ b/src/a.ts\n@@ -0,0 +1 @@\n+newValue();\n",
    "diff --git a/src/a.ts b/src/a.ts\ndeleted file mode 100644\nindex 1234567..0000000\n--- a/src/a.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-old();\n",
    'diff --git "a/src/a.ts" "b/src/a.ts"\n',
    "diff --git a/src/a.ts b/src/a.ts\nold mode 100644\nnew mode 100755\n",
    "diff --git a/src/a.ts b/src/a.ts\nindex abc1234..def5678 120000\nGIT binary patch\n",
  ])("rejects structural edits without consulting a checkout (%#)", (text) => {
    expect(guardPatch(text, result).passed).toBe(false);
  });
  it("rejects incomplete hunks, duplicate file sections, empty patches and low confidence", () => {
    expect(guardPatch(patch().replace("@@ -1,1 +1,1 @@", "@@ -1,2 +1,1 @@"), result).passed).toBe(
      false,
    );
    expect(guardPatch(patch() + patch(), result).passed).toBe(false);
    expect(guardPatch("", result).passed).toBe(false);
    expect(guardPatch(patch(), { ...result, confidence: "medium" }).passed).toBe(false);
    expect(guardPatch(patch(), { ...result, action: "diagnose" }).passed).toBe(false);
    expect(guardPatch(patch(), { ...result, classification: "unknown" }).passed).toBe(false);
  });
  it("rejects an unparsed unified diff hidden before a permitted Git diff", () => {
    const hidden = "--- a/package.json\n+++ b/package.json\n@@ -1 +1 @@\n-old\n+new\n";
    expect(guardPatch(hidden + patch(), result).reasons).toContain("Unexpected patch preamble");
    const mail = `From ${"a".repeat(40)} Mon Sep 17 00:00:00 2001\nSubject: [PATCH] fix\n\n`;
    expect(guardPatch(mail + hidden + patch(), result).reasons).toContain(
      "Unexpected patch preamble",
    );
  });
  it("preserves trailing blank context and no-newline markers", () => {
    const text = patch().replace("@@ -1,1 +1,1 @@", "@@ -1,2 +1,2 @@") + " \n";
    expect(guardPatch(text, result).passed).toBe(true);
    expect(guardPatch(`${patch()}\\ No newline at end of file\n`, result).passed).toBe(true);
  });
});

it("renders model and log text as escaped prose while retaining the trusted run link", () => {
  const text = renderPrBody({
    runId: 123,
    attempt: 2,
    result: {
      ...result,
      cause: "<script>@everyone</script>\n# forged",
      evidence: "[click](https://evil.invalid) `code` & |",
    },
    tests: result.failingTests,
    guard: guardPatch(patch(), result),
    prove: "passed\n## spoof",
    base: "a".repeat(40),
  });
  expect(text).toContain("https://github.com/openclaw/openclaw/actions/runs/123/attempts/2");
  expect(text).toContain("&lt;script&gt;&#64;everyone&lt;/script&gt; \\# forged");
  expect(text).toContain("\\[click\\]\\(https://evil\\.invalid\\) \\`code\\` &amp; \\|");
  expect(text).not.toContain("\n## spoof");
  expect(text).toContain(
    "The prove verdict is evidence recorded by the repair job; this PR's own CI and review are authoritative.",
  );
  expect(escapeMarkdown("@user <b> &")).toBe("&#64;user &lt;b&gt; &amp;");
});

it("admits only completed canonical failures and permits push only on dispatch", () => {
  const run = {
    id: 123,
    attempt: 1,
    sha: "a".repeat(40),
    event: "schedule",
    branch: "main",
    path: ".github/workflows/ci.yml",
    repository: "openclaw/openclaw",
    headRepository: "openclaw/openclaw",
    status: "completed",
    conclusion: "failure",
    createdAt: "2026-09-26T00:00:00Z",
  };
  expect(canonicalFailure(run, false)).toBe(true);
  expect(canonicalFailure({ ...run, event: "push" }, false)).toBe(false);
  expect(canonicalFailure({ ...run, event: "push" }, true)).toBe(true);
  for (const change of [
    { repository: "fork/openclaw" },
    { headRepository: "fork/openclaw" },
    { branch: "topic" },
    { conclusion: "success" },
    { status: "in_progress" },
    { path: ".github/workflows/other.yml" },
    { event: "pull_request" },
  ]) {
    expect(canonicalFailure({ ...run, ...change }, true)).toBe(false);
  }
});
