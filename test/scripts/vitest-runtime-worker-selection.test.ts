import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import {
  TUI_PTY_BUILT_CLI_CANARY_PATTERN,
  shouldUseRuntimeOnlyVitestWorkers,
} from "../../scripts/lib/vitest-runtime-selection.mts";

const e2e = "test/vitest/vitest.e2e.config.ts";
const tui = "test/vitest/vitest.tui-pty.config.ts";
const doctor = "test/scripts/doctor-config-preflight-plugin-index.built-cli.e2e.test.ts";
const sqlite = "test/scripts/sqlite-sessions-transcripts-flip-proof.built-cli.e2e.test.ts";
const nativeHost = "extensions/browser/src/browser/extension-install.native-host.e2e.test.ts";
const discord = "test/e2e/qa-lab/plugins/discord-show-widget-contextual-presenter.e2e.test.ts";
const local = "src/tui/tui-pty-local.e2e.test.ts";
const built = { OPENCLAW_TUI_PTY_USE_BUILT_CLI: "1" };

it.each([
  { name: "Doctor", config: e2e, files: [doctor], env: {}, runtime: true },
  { name: "SQLite", config: e2e, files: [sqlite], env: {}, runtime: true },
  { name: "native host", config: e2e, files: [nativeHost], env: {}, runtime: true },
  { name: "Discord attachment", config: e2e, files: [discord], env: {}, runtime: true },
  {
    name: "all built proofs",
    config: e2e,
    files: [doctor, `./${sqlite}`, nativeHost, discord],
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
  {
    name: "built local PTY canaries",
    config: tui,
    files: [local],
    env: built,
    pattern: TUI_PTY_BUILT_CLI_CANARY_PATTERN,
    runtime: true,
  },
  {
    name: "built local PTY canaries as RegExp",
    config: tui,
    files: [local],
    env: built,
    pattern: new RegExp(TUI_PTY_BUILT_CLI_CANARY_PATTERN),
    runtime: true,
  },
  { name: "complete built local PTY", config: tui, files: [local], env: built, runtime: false },
  {
    name: "arbitrary built local PTY selection",
    config: tui,
    files: [local],
    env: built,
    pattern: "launches openclaw|control-channel",
    runtime: false,
  },
  {
    name: "source local PTY canaries",
    config: tui,
    files: [local],
    env: {},
    pattern: TUI_PTY_BUILT_CLI_CANARY_PATTERN,
    runtime: false,
  },
  { name: "source local PTY", config: tui, files: [local], env: {}, runtime: false },
  {
    name: "broad built PTY",
    config: tui,
    files: [],
    env: built,
    pattern: TUI_PTY_BUILT_CLI_CANARY_PATTERN,
    runtime: false,
  },
  {
    name: "mixed built PTY",
    config: tui,
    files: [local, "src/tui/tui-pty-harness.e2e.test.ts"],
    env: built,
    pattern: TUI_PTY_BUILT_CLI_CANARY_PATTERN,
    runtime: false,
  },
])("keeps the compiler scope for $name", ({ config, files, env, pattern, runtime }) => {
  expect(shouldUseRuntimeOnlyVitestWorkers(config, ["run", ...files], env, pattern)).toBe(runtime);
});

it("keeps the built PTY CI canary aligned with runtime-only preparation", () => {
  const workflow = readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8");
  expect(workflow).toContain(`--testNamePattern "${TUI_PTY_BUILT_CLI_CANARY_PATTERN}"`);
});
