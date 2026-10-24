import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const UNKNOWN_PACKAGE = "@openclaw/not-a-real-release-wrapper-test-package";
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const tsxImport = new URL("../../scripts/tsx.mjs", import.meta.url).href;
const scripts = join(process.cwd(), "scripts");
const releaseSha = "a".repeat(40);
const toolingSha = "b".repeat(40);
const plannerFlags = (overrides: Record<string, string> = {}) =>
  Object.entries({
    "bootstrap-workflow-ref": "main",
    "bootstrap-workflow-sha": toolingSha,
    "release-tag": "v2026.6.21-beta.1",
    "release-sha": releaseSha,
    "release-publish-run-attempt": "1",
    "release-publish-run-id": "123",
    ...overrides,
  }).flatMap(([key, value]) => [`--${key}`, value]);

function runScript(name: string, args: readonly string[], cwd = process.cwd()) {
  const script = join(scripts, `${name}.ts`);
  return spawnSync(process.execPath, ["--import", tsxImport, script, ...args], {
    cwd,
    encoding: "utf8",
  });
}

const selectionError = `Unknown or non-publishable plugin package selection: ${UNKNOWN_PACKAGE}.`;
const selectionArgs = ["--plugins", UNKNOWN_PACKAGE];
it.each([
  ...["npm", "clawhub"].flatMap((registry) =>
    ["plan", "check"].map(
      (action) => [`plugin-${registry}-release-${action}`, selectionArgs, selectionError] as const,
    ),
  ),
  ["openclaw-release-clawhub-plan", plannerFlags(), "--release-publish-branch is required."],
  ["release-verify-beta", ["--skip-clawhub"], "Usage: pnpm release:verify-beta -- <version>"],
] as const)("%s rejects invalid input before remote checks", (script, args, error) => {
  const result = runScript(script, args);
  expect(result, result.stderr).toMatchObject({
    status: 1,
    stdout: "",
    stderr: expect.stringContaining(error),
  });
});

it("runs trusted harness planning and verification against an old release target cwd", () => {
  const oldTarget = tempDirs.make("openclaw-old-release-target-");
  mkdirSync(join(oldTarget, "extensions"));
  mkdirSync(join(oldTarget, "scripts"));
  writeFileSync(
    join(oldTarget, "package.json"),
    JSON.stringify({ name: "openclaw", version: "2026.7.1-beta.3" }),
  );
  writeFileSync(
    join(oldTarget, "scripts/openclaw-release-clawhub-plan.ts"),
    'throw new Error("old target planner invoked");\n',
  );
  writeFileSync(
    join(oldTarget, "scripts/release-verify-beta.ts"),
    'throw new Error("old target verifier invoked");\n',
  );
  const bootstrapWorkflowRef = `release-publish/${"b".repeat(12)}-123`;
  const plan = runScript(
    "openclaw-release-clawhub-plan",
    plannerFlags({
      "bootstrap-workflow-ref": bootstrapWorkflowRef,
      "release-tag": "v2026.7.1-beta.3",
      "release-publish-branch": "main",
      "release-publish-full-ref": "refs/heads/main",
      "plugin-publish-scope": "all-publishable",
    }),
    oldTarget,
  );
  expect(plan.status, plan.stderr).toBe(0);
  expect(JSON.parse(plan.stdout)).toMatchObject({
    bootstrapWorkflowSha: "b".repeat(40),
    bootstrap: { ref: bootstrapWorkflowRef, shouldDispatch: false },
    normal: { ref: bootstrapWorkflowRef, shouldDispatch: false },
  });
  expect(plan.stderr).not.toContain("old target planner invoked");

  const verify = runScript(
    "release-verify-beta",
    [
      "2026.7.1-beta.4",
      "--release-sha",
      releaseSha,
      "--clawhub-bootstrap-plugins",
      "@openclaw/meta",
      "--plugin-clawhub-bootstrap-run",
      "34",
    ],
    oldTarget,
  );
  expect(verify, verify.stderr).toMatchObject({
    status: 1,
    stderr: expect.stringContaining(
      "package.json version is 2026.7.1-beta.3; expected 2026.7.1-beta.4.",
    ),
  });
  expect(verify.stderr).not.toContain("old target verifier invoked");
  expect(verify.stderr).not.toContain("Unknown argument");
});
