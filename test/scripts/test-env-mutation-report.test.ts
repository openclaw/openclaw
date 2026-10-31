import { expect, it } from "vitest";
import {
  collectTestEnvMutationReport,
  renderTestEnvMutationReport,
} from "../../scripts/test-env-mutation-report.js";
import { createScriptTestHarness } from "./test-helpers.js";
import { writeFixtureFiles } from "./z0632-fixtures.test-support.js";

const { createTempDir } = createScriptTestHarness();

function makeRepo(files: Record<string, string>) {
  const repoRoot = createTempDir("openclaw-test-env-mutations-");
  writeFixtureFiles(repoRoot, files);
  return repoRoot;
}

it("scans static and dynamic mutations while ignoring non-code and ordinary source files", () => {
  const repoRoot = makeRepo({
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
  const report = collectTestEnvMutationReport({ repoRoot });
  expect(renderTestEnvMutationReport(report, { includeAllowed: true })).toContain(
    "Findings: 9 active in 3 file(s), 2 allowed in 1 file(s)",
  );
});

it("caps active and allowed sections independently", () => {
  // CLI errors/unlimited output: inventory-report-cli.test.ts; grouping: test-skip-inventory.test.ts.
  const repoRoot = makeRepo({
    "src/z.test.ts": 'vi.stubEnv("HOME", "z");\ndelete process.env.HOME;\n',
    "src/test-utils/openclaw-test-state.ts":
      'process.env.HOME = "allowed";\ndelete process.env.HOME;\n',
  });
  const report = collectTestEnvMutationReport({ repoRoot });
  const output = renderTestEnvMutationReport(report, { includeAllowed: true, limit: 1 });
  expect(output.match(/^ {2}L\d/gmu)).toHaveLength(2);
  expect(output.match(/^\.\.\. 1 more finding/gmu)).toHaveLength(2);
  expect(output).toContain('- src/z.test.ts (2)\n  L1 HOME vi.stubEnv: vi.stubEnv("HOME", "z");');
  expect(output).toContain(
    '- src/test-utils/openclaw-test-state.ts (2)\n  L1 HOME assign process.env: process.env.HOME = "allowed";',
  );
});

it("reports no active findings for an empty repository", () => {
  const report = collectTestEnvMutationReport({ repoRoot: createTempDir("openclaw-env-empty-") });
  expect(report).toMatchObject({ activeFindings: [], allowedFindings: [], scannedFileCount: 0 });
  expect(renderTestEnvMutationReport(report, { includeAllowed: true })).toContain(
    "Active findings: none",
  );
});
