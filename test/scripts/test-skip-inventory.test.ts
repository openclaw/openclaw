import { spawnSync } from "node:child_process";
import path from "node:path";
import { expect, it } from "vitest";
import {
  collectTestSkipInventoryReport,
  main as runTestSkipInventory,
  renderTestSkipInventoryReport,
} from "../../scripts/test-skip-inventory.js";
import { fixtureFiles } from "./script-fixture-files.test-support.js";
import { createScriptTestHarness } from "./test-helpers.js";

const { createTempDir } = createScriptTestHarness();

function collectFixture(files: Record<string, string> = {}) {
  const repoRoot = createTempDir("openclaw-test-skip-inventory-");
  const { write } = fixtureFiles(repoRoot);
  for (const [file, source] of Object.entries(files)) {
    write(file, source);
  }
  return collectTestSkipInventoryReport({ repoRoot });
}
const skipSources = {
  "src/runtime.ts": '\ndescribe.skip("ignored because this is not a test file", () => {});\n',
  "src/example.test.ts": `
describe.skip("temporarily disabled suite", () => {});
it.skipIf(process.platform === "win32")("uses POSIX shell", () => {});
test.todo("covers migration edge");
it.only("focused during local debugging", () => {});
const posixIt = process.platform === "win32" ? it.skip : it;
(process.platform === "win32" ? it.skip : it)("uses terminal fixtures", () => {});
it.runIf(process.platform !== "win32")("runs only on POSIX", () => {});
it.runIf(process.platform !== "win32").each(["SIGTERM"] as const)("handles %s", () => {});
const runIfPowerShell = powershell ? it : it.skip;
it.concurrent.only("focused concurrent test", () => {});
test.skip("skipped sequential test", { concurrent: false }, () => {});
const fixture = 'describe.skip("not code", () => {})';
`,
  "test/e2e/qa-lab/runtime/qa-otel-smoke-runtime.ts": "\nreader.skip(wire);\n",
  "test/scripts/test-live.test.ts":
    '\nconst posixIt = process.platform === "win32" ? it.skip : it;\n',
  "extensions/provider/live.test.ts": `
const LIVE = process.env.OPENCLAW_LIVE_TEST === "1";
const describeLive = LIVE ? describe : describe.skip;
describeLive("provider live", () => {});
`,
  "ui/src/e2e/chat-flow.e2e.test.ts": `
const describeControlUiE2e = chromiumAvailable || !allowMissingChromium ? describe : describe.skip;
describeControlUiE2e("control UI", () => {});
`,
};

it("renders a compact non-blocking text report", () => {
  const rendered = renderTestSkipInventoryReport(collectFixture(skipSources), { limit: 4 });
  for (const text of [
    "OpenClaw test skip inventory",
    "Findings: 14 in 4 file(s)",
    "platform-gate: 6",
    "- src/example.test.ts (11)",
    "L2 describe.skip explicit-skip",
    "... 10 more finding(s) not shown",
  ]) {
    expect(rendered).toContain(text);
  }
});

it("rejects missing CLI repo roots and loose limits before scanning", () => {
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      path.join(process.cwd(), "scripts/test-skip-inventory.ts"),
      "--",
      "--repo-root",
      "--json",
    ],
    { encoding: "utf8" },
  );

  expect(result.status).toBe(1);
  expect(result.stderr).toContain("--repo-root expects a path");
  expect(result.stdout).not.toContain("Scanned files:");
  expect(() =>
    runTestSkipInventory([
      "--",
      "--limit",
      "1e3",
      "--repo-root",
      createTempDir("openclaw-skip-limit-"),
    ]),
  ).toThrow("--limit expects a non-negative integer");
});

it("preserves first-seen groups with unlimited output", () => {
  const report = collectFixture({
    "src/a.test.ts": 'test.todo("a");\n',
    "src/z.test.ts": 'it.skip("z", () => {});\nit.only("second", () => {});\n',
  });
  const findings = report.findings;
  report.findings = [...findings.slice(1, 2), ...findings.slice(0, 1), ...findings.slice(2)];
  const rendered = renderTestSkipInventoryReport(report, { limit: 0 });
  expect(rendered.match(/^- .+$/gmu)).toEqual(["- src/z.test.ts (2)", "- src/a.test.ts (1)"]);
  expect(rendered).toContain('L2 it.only focused-only: it.only("second", () => {});');
  expect(rendered).toContain('L1 test.todo todo: test.todo("a");');
  expect(rendered).not.toContain("not shown");
});

it("keeps the empty report output unchanged", () => {
  expect(renderTestSkipInventoryReport(collectFixture())).toBe(
    "OpenClaw test skip inventory\nScanned files: 0\nFindings: 0 in 0 file(s)\nReasons: none\n\nFindings: none\n",
  );
});
