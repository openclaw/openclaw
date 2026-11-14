import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { checkActivatedGatewayStartup } from "./update-activated-gateway-check.js";
import { preparePublicUpdateFailureIdentifiers } from "./update-failure-public-identifiers.js";
import { prepareUpdateFailureReport } from "./update-failure-report-prepare.js";

const timing = vi.hoisted(() => ({ timeout: false }));
// Only shorten the timeout case; keep the real readiness, pipe capture and process cleanup owners.
vi.mock("./update-candidate-canary-readiness.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./update-candidate-canary-readiness.js")>();
  return {
    ...actual,
    waitForUpdateCandidateReadiness: (
      params: Parameters<typeof actual.waitForUpdateCandidateReadiness>[0],
    ) =>
      actual.waitForUpdateCandidateReadiness({
        ...params,
        ...(timing.timeout ? { workDeadline: Date.now() + 250 } : {}),
      }),
  };
});
const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  timing.timeout = false;
});
await preparePublicUpdateFailureIdentifiers();

it.each([
  ["long", "plugin load failed: discord"],
  ["unterminated", "plugin load failed: discord"],
  ["signal", "startup crash with signal SIGTERM"],
  ["timeout", "readiness timeout"],
] as const)("reports activated startup %s without private diagnostics", async (kind, expected) => {
  const root = await fs.realpath(dirs.make("activated-report-"));
  const stateDir = path.join(root, "state");
  await fs.mkdir(stateDir);
  await fs.mkdir(path.join(root, "dist"));
  await fs.writeFile(path.join(root, "package.json"), '{"type":"module"}');
  await fs.writeFile(
    path.join(root, "dist", "index.js"),
    `
const kind = ${JSON.stringify(kind)};
if (kind === "timeout") {
  console.error("openclaw-update-canary-progress: entry.bootstrap");
  setInterval(() => {}, 1000);
} else if (kind === "unterminated") {
  process.stderr.write("plugin load failed: discord: private-tenant at /private/customer token=synthetic-secret");
  process.exitCode = 1;
} else {
  console.error("plugin load failed: discord: private-tenant at /private/customer token=synthetic-secret");
  for (let i = 0; i < 120; i++) console.error("private stack at /private/customer private-host.example token=synthetic-secret");
  if (kind === "signal") process.stderr.write("", () => process.kill(process.pid, "SIGTERM"));
  else process.exitCode = 1;
}
`,
  );
  timing.timeout = kind === "timeout";
  const env = { OPENCLAW_STATE_DIR: stateDir, HOME: root };
  const result = await checkActivatedGatewayStartup({
    result: { status: "ok", mode: "git", root, steps: [], durationMs: 0 },
    env,
    stateDir,
    assertCurrent: () => {},
  });
  expect(result.status).toBe("error");
  const expectedFact = kind === "long" || kind === "unterminated" ? "plugin load failed" : expected;
  expect(result.steps[0]?.failureFacts?.some((fact) => fact.message === expectedFact)).toBe(true);
  if (kind === "signal" || kind === "timeout") {
    expect(result.steps[0]?.termination).toBe(kind);
  }
  const report = await prepareUpdateFailureReport(
    { attemptId: "activated-startup", result },
    { env, stateDir },
  );
  expect(report.body).toContain(expected);
  for (const privateText of [
    "private-tenant",
    "/private/customer",
    "private-host",
    "synthetic-secret",
  ]) {
    expect(report.body).not.toContain(privateText);
  }
});
