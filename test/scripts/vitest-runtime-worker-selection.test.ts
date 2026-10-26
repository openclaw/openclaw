import { expect, it } from "vitest";
import { shouldUseRuntimeOnlyVitestWorkers } from "../../scripts/lib/vitest-runtime-selection.mts";

const e2e = "test/vitest/vitest.e2e.config.ts";
const tui = "test/vitest/vitest.tui-pty.config.ts";
const doctor = "test/scripts/doctor-config-preflight-plugin-index.built-cli.e2e.test.ts";
const sqlite = "test/scripts/sqlite-sessions-transcripts-flip-proof.built-cli.e2e.test.ts";
const local = "src/tui/tui-pty-local.e2e.test.ts";
const built = { OPENCLAW_TUI_PTY_USE_BUILT_CLI: "1" };

it.each([
  { name: "Doctor", config: e2e, files: [doctor], env: {}, runtime: true },
  { name: "SQLite", config: e2e, files: [sqlite], env: {}, runtime: true },
  {
    name: "both built proofs",
    config: e2e,
    files: [doctor, `./${sqlite}`],
    env: {},
    runtime: true,
  },
  { name: "broad E2E", config: e2e, files: [], env: {}, runtime: false },
  { name: "E2E directory", config: e2e, files: ["test/scripts"], env: {}, runtime: false },
  {
    name: "unknown built proof",
    config: e2e,
    files: ["test/scripts/other.built-cli.e2e.test.ts"],
    env: {},
    runtime: false,
  },
  {
    name: "mixed E2E",
    config: e2e,
    files: [doctor, "test/e2e/other.e2e.test.ts"],
    env: {},
    runtime: false,
  },
  { name: "custom config", config: "custom.config.ts", files: [doctor], env: {}, runtime: false },
  { name: "built local PTY", config: tui, files: [local], env: built, runtime: true },
  { name: "source local PTY", config: tui, files: [local], env: {}, runtime: false },
  { name: "broad built PTY", config: tui, files: [], env: built, runtime: false },
  {
    name: "mixed built PTY",
    config: tui,
    files: [local, "src/tui/tui-pty-harness.e2e.test.ts"],
    env: built,
    runtime: false,
  },
])("keeps the compiler scope for $name", ({ config, files, env, runtime }) => {
  expect(shouldUseRuntimeOnlyVitestWorkers(config, ["run", ...files], env)).toBe(runtime);
});
