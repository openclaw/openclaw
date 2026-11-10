import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import {
  TUI_PTY_BUILT_CLI_CANARY_PATTERN,
  shouldUseRuntimeOnlyVitestWorkers,
  shouldUseToolingOnlyVitestWorkers,
} from "../../scripts/lib/vitest-runtime-selection.mts";
import { boundaryTestFiles } from "../vitest/vitest.unit-paths.mjs";

const e2e = "test/vitest/vitest.e2e.config.ts";
const tui = "test/vitest/vitest.tui-pty.config.ts";
const doctor = "test/scripts/doctor-config-preflight-plugin-index.built-cli.e2e.test.ts";
const sqlite = "test/scripts/sqlite-sessions-transcripts-flip-proof.built-cli.e2e.test.ts";
const nativeHost = "extensions/browser/src/browser/extension-install.native-host.e2e.test.ts";
const discord = "test/e2e/qa-lab/plugins/discord-show-widget-contextual-presenter.e2e.test.ts";
const local = "src/tui/tui-pty-local.e2e.test.ts";
const built = { OPENCLAW_TUI_PTY_USE_BUILT_CLI: "1" };
const reply = "test/vitest/vitest.auto-reply.config.ts";
const delivery = "src/auto-reply/reply/dispatch-from-config.delivery.test.ts";
const commands = "test/vitest/vitest.commands.config.ts";
const doctorCommandFiles = [
  "src/commands/doctor-config-preflight.container-upgrade.test.ts",
  "src/commands/doctor-maintenance.schema-preflight.test.ts",
  "src/commands/doctor-maintenance.stopped-systemd.test.ts",
  "src/commands/doctor-plugin-package-consent.test.ts",
];

it.each([
  { name: "Doctor commands", config: commands, files: doctorCommandFiles, runtime: true },
  {
    name: "Doctor update schema",
    config: "test/vitest/vitest.infra.config.ts",
    files: ["src/flows/doctor-health.update-schema.test.ts"],
    runtime: true,
  },
  { name: "broad Doctor commands", config: commands, files: [], runtime: false },
  {
    name: "mixed Doctor commands",
    config: commands,
    files: [...doctorCommandFiles, "src/commands/unknown.test.ts"],
    runtime: false,
  },
  {
    name: "Doctor setup and runtime registry",
    config: "test/vitest/vitest.plugins.config.ts",
    files: [
      "src/plugins/doctor-repair-setup.test.ts",
      "src/plugins/loader.runtime-registry.test.ts",
    ],
    runtime: true,
  },
  { name: "reply delivery", config: reply, files: [delivery], runtime: true },
  { name: "broad reply", config: reply, files: [], runtime: false },
  {
    name: "custom reply config",
    config: "custom.config.ts",
    files: [delivery],
    runtime: false,
  },
  {
    name: "mixed reply",
    config: reply,
    files: [delivery, "src/auto-reply/reply/unknown.test.ts"],
    runtime: false,
  },
  { name: "Doctor", config: e2e, files: [doctor], runtime: true },
  { name: "SQLite", config: e2e, files: [sqlite], runtime: true },
  { name: "native host", config: e2e, files: [nativeHost], runtime: true },
  { name: "Discord attachment", config: e2e, files: [discord], runtime: true },
  {
    name: "all built proofs",
    config: e2e,
    files: [doctor, `./${sqlite}`, nativeHost, discord],
    runtime: true,
  },
  { name: "broad E2E", config: e2e, files: [], runtime: false },
  { name: "E2E directory", config: e2e, files: ["test/scripts"], runtime: false },
  {
    name: "unknown built proof",
    config: e2e,
    files: ["test/scripts/other.built-cli.e2e.test.ts"],
    runtime: false,
  },
  {
    name: "mixed E2E",
    config: e2e,
    files: [doctor, "test/e2e/other.e2e.test.ts"],
    runtime: false,
  },
  { name: "custom config", config: "custom.config.ts", files: [doctor], runtime: false },
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
    pattern: TUI_PTY_BUILT_CLI_CANARY_PATTERN,
    runtime: false,
  },
  { name: "source local PTY", config: tui, files: [local], runtime: false },
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
])("keeps the compiler scope for $name", ({ config, files, env = {}, pattern, runtime }) => {
  expect(shouldUseRuntimeOnlyVitestWorkers(config, ["run", ...files], env, pattern)).toBe(runtime);
});

it("retains full workers when the boundary inventory gains an unqualified owner", () => {
  const previousLength = boundaryTestFiles.length;
  boundaryTestFiles.push("test/new-boundary-owner.test.ts");
  try {
    expect(
      shouldUseToolingOnlyVitestWorkers("test/vitest/vitest.boundary.config.ts", ["run"], {}),
    ).toBe(false);
  } finally {
    boundaryTestFiles.length = previousLength;
  }
});

it("keeps the built PTY CI canary aligned with runtime-only preparation", () => {
  const workflow = readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8");
  expect(workflow).toContain(`--testNamePattern "${TUI_PTY_BUILT_CLI_CANARY_PATTERN}"`);
});
