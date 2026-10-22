import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import {
  collectTestEnvMutationReport,
  renderTestEnvMutationReport,
} from "../../scripts/test-env-mutation-report.js";
import { createScriptTestHarness } from "./test-helpers.js";

const { createTempDir } = createScriptTestHarness();

function runCli(args: string[]) {
  return spawnSync(
    process.execPath,
    ["--import", "tsx", path.join(process.cwd(), "scripts/test-env-mutation-report.ts"), ...args],
    { encoding: "utf8" },
  );
}

function makeRepo(files: Record<string, string>) {
  const repoRoot = createTempDir("openclaw-test-env-mutations-");
  for (const [file, content] of Object.entries(files)) {
    const target = path.join(repoRoot, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content, "utf8");
  }
  return repoRoot;
}

function makeEnvMutationFixture(): string {
  return makeRepo({
    "src/runtime.ts":
      '\nprocess.env.OPENCLAW_STATE_DIR = "ignored because this is not a test file";\n',
    "src/example.test.ts": `
process.env.OPENCLAW_STATE_DIR = "state";
delete process.env["OPENCLAW_CONFIG_PATH"];
vi.stubEnv("HOME", "home");
vi.stubEnv("OPENCLAW_WORKSPACE_DIR", "workspace");
process.env = { ...process.env, OPENCLAW_HOME: "home", OTHER_KEY: "ignored" };
const dynamicEnvKey = "OPENCLAW_STATE_DIR";
process.env[dynamicEnvKey] = "dynamic";
delete process.env[dynamicEnvKey];
const fixture = 'process.env.OPENCLAW_HOME = "not code"';
process.env.NOT_OPENCLAW = "ignored";
`,
    "scripts/mcp-code-mode-gateway-e2e.ts":
      '\nprocess.env.OPENCLAW_CONFIG_PATH = "script-harness";\n',
    "src/agents/auth-profiles/oauth-test-utils.ts": '\nprocess.env.OPENCLAW_AGENT_DIR = "agent";\n',
    "src/test-utils/openclaw-test-state.ts":
      '\nprocess.env.HOME = "allowed";\ndelete process.env.OPENCLAW_STATE_DIR;\n',
  });
}

it("scans static and dynamic mutations while ignoring non-code and ordinary source files", () => {
  const report = collectTestEnvMutationReport({ repoRoot: makeEnvMutationFixture() });
  expect(renderTestEnvMutationReport(report, { includeAllowed: true })).toContain(
    "Findings: 9 active in 3 file(s), 2 allowed in 1 file(s)",
  );
});

it("rejects missing or flag-shaped CLI repo roots instead of scanning zero files", () => {
  const result = runCli(["--", "--repo-root", "--json"]);

  expect(result.status).toBe(1);
  expect(result.stderr).toContain("--repo-root expects a path");
});

it.each([1, 0])("preserves grouped output and each section's cap with limit %s", (limit) => {
  const repoRoot = makeRepo({
    "src/a.test.ts": 'process.env.HOME = "a";\n',
    "src/z.test.ts": 'vi.stubEnv("HOME", "z");\ndelete process.env.HOME;\n',
    "src/test-utils/openclaw-test-state.ts":
      'process.env.HOME = "allowed";\ndelete process.env.HOME;\n',
  });
  const report = collectTestEnvMutationReport({ repoRoot });
  const findings = report.activeFindings;
  report.activeFindings = [findings[1]!, findings[0]!, ...findings.slice(2)];
  const remainder = (count: number) =>
    `... ${count} more finding(s) not shown; pass --limit 0 to show all.`;
  const activeTail = limit
    ? remainder(2)
    : `  L2 HOME delete process.env: delete process.env.HOME;
- src/a.test.ts (1)
  L1 HOME assign process.env: process.env.HOME = "a";`;
  const allowedTail = limit
    ? remainder(1)
    : "  L2 HOME delete process.env: delete process.env.HOME;";
  expect(renderTestEnvMutationReport(report, { includeAllowed: true, limit })).toBe(
    `OpenClaw test env mutation report
Scanned files: 3
Findings: 3 active in 2 file(s), 2 allowed in 1 file(s)

Active findings:
- src/z.test.ts (2)
  L1 HOME vi.stubEnv: vi.stubEnv("HOME", "z");
${activeTail}

Allowed harness findings:
- src/test-utils/openclaw-test-state.ts (2)
  L1 HOME assign process.env: process.env.HOME = "allowed";
${allowedTail}
`,
  );
});

it("keeps the empty report output unchanged", () => {
  const report = collectTestEnvMutationReport({ repoRoot: createTempDir("openclaw-env-empty-") });
  expect(renderTestEnvMutationReport(report, { includeAllowed: true })).toBe(
    "OpenClaw test env mutation report\nScanned files: 0\nFindings: 0 active in 0 file(s), 0 allowed in 0 file(s)\n\nActive findings: none\n",
  );
});
