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

it.each(["npm", "clawhub"])("rejects unknown %s packages before remote checks", (registry) => {
  const result = runScript(`plugin-${registry}-release-check`, ["--plugins", UNKNOWN_PACKAGE]);
  expect(result, result.stderr).toMatchObject({
    status: 1,
    stdout: "",
    stderr: expect.stringContaining(
      `Unknown or non-publishable plugin package selection: ${UNKNOWN_PACKAGE}.`,
    ),
  });
});

it("requires a version before release verification", () => {
  expect(runScript("release-verify-beta", ["--skip-clawhub"])).toMatchObject({
    status: 1,
    stdout: "",
    stderr: expect.stringContaining("Usage: pnpm release:verify-beta -- <version>"),
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
  for (const script of ["openclaw-release-clawhub-plan", "release-verify-beta"]) {
    writeFileSync(
      join(oldTarget, `scripts/${script}.ts`),
      'throw new Error("old target invoked");\n',
    );
  }
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
});
