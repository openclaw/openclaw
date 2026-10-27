import fs from "node:fs/promises";
import path from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stripAnsi } from "../../packages/terminal-core/src/ansi.js";
import { hasTerminalControl } from "../../packages/terminal-core/src/safe-text.js";
import { withContendedConfigMutation } from "../../test/helpers/config-mutation-lock.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as config from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import * as gateway from "../gateway/call.js";
import type { HookStatusEntry, HookStatusReport } from "../hooks/hooks-status.js";
import { buildWorkspaceHookStatus } from "../hooks/hooks-status.js";
import { defaultRuntime } from "../runtime.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { makeHookStatusEntry } from "./cli-fixtures.test-support.js";
import { registerHooksCli } from "./hooks-cli.js";
import * as oneShotExit from "./one-shot-exit.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const escape = "\u001b]0;untrusted-title\u0007\u009f";
const untrusted = (text: string) => `${text}${escape}`;
const descriptorConfig = { plugins: { enabled: false } };
const runPluginInstallCommandMock = vi.hoisted(() => vi.fn());
const runPluginUpdateCommandMock = vi.hoisted(() => vi.fn());

vi.mock("./plugins-install-command.js", () => ({
  runPluginInstallCommand: runPluginInstallCommandMock,
}));

vi.mock("./plugins-update-command.js", () => ({
  runPluginUpdateCommand: runPluginUpdateCommandMock,
}));

const hook = makeHookStatusEntry({
  emoji: "💾",
  homepage: "https://docs.openclaw.ai/automation/hooks#session-memory",
});
function withHook(overrides: Partial<HookStatusEntry> = {}): HookStatusReport {
  return {
    workspaceDir: "/tmp/workspace",
    managedHooksDir: "/tmp/hooks",
    hooks: [{ ...hook, ...overrides }],
  };
}
const eventlessHook = {
  events: [],
  loadable: false,
  blockedReason: "no events defined",
} satisfies Partial<HookStatusEntry>;
const eventless = withHook(eventlessHook);
const hookAgent = (workspace: string) => ({
  ownership: "explicit" as const,
  entries: { fixture: { workspace } },
  defaults: { systemAgent: { agentId: "fixture" } },
});

function hooksProgram() {
  const program = new Command().enablePositionalOptions().exitOverride();
  registerHooksCli(program);
  return program;
}

beforeEach(() => {
  runPluginInstallCommandMock.mockReset();
  runPluginUpdateCommandMock.mockReset();
});

async function runHooksReport(statusReport: HookStatusReport, args: string[]): Promise<string> {
  const fixtureConfig: OpenClawConfig = {
    agents: hookAgent(statusReport.workspaceDir),
  };
  const output: string[] = [];
  const reader = Object.assign(async () => fixtureConfig, { assertCurrent() {} });
  const spies = [
    vi.spyOn(config, "captureRuntimeConfigAsyncReader").mockReturnValue(reader),
    vi.spyOn(gateway, "callGateway").mockResolvedValue(statusReport),
    vi.spyOn(defaultRuntime, "log").mockImplementation((value) => output.push(String(value))),
    vi.spyOn(defaultRuntime, "writeStdout").mockImplementation((value) => output.push(value)),
    vi.spyOn(oneShotExit, "requestExitAfterOneShotOutput").mockReturnValue(true),
  ];
  try {
    await hooksProgram().parseAsync(["hooks", ...args], { from: "user" });
    return output.join("\n");
  } finally {
    for (const spy of spies) {
      spy.mockRestore();
    }
  }
}

it("renders hook metadata and requirements safely while retaining raw JSON values", async () => {
  const workspaceDir = tempDirs.make("hook-terminal-");
  const directory = path.join(workspaceDir, "hooks", "terminal-fixture");
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(
    path.join(directory, "HOOK.md"),
    `---\nname: terminal-fixture\ndescription: ${JSON.stringify(untrusted("Readable description\nsecond\tline"))}\nmetadata: ${JSON.stringify(
      {
        openclaw: {
          emoji: untrusted("🔗"),
          homepage: untrusted("https://example.com/hook"),
          events: ["command:new", untrusted("unknown:event")],
          requires: { env: [untrusted("MISSING_HOOK_ENV")] },
        },
      },
    )}\n---\nHook fixture.\n`,
  );
  await fs.writeFile(path.join(directory, "handler.js"), 'throw new Error("must not load");\n');
  const report = buildWorkspaceHookStatus(workspaceDir, {
    config: descriptorConfig,
  });
  const entry = report.hooks.find((candidate) => candidate.name === "terminal-fixture");
  expect(entry?.emoji).toBe(untrusted("🔗"));
  const infoText = await runHooksReport(report, ["info", "terminal-fixture"]);
  const outputs = [
    await runHooksReport(report, ["list", "--verbose"]),
    infoText,
    await runHooksReport(report, ["check"]),
  ];
  for (const output of outputs) {
    expect(
      hasTerminalControl(
        stripAnsi(output).replaceAll("\n", "").replaceAll("\r", "").replaceAll("\t", ""),
      ),
    ).toBe(false);
    expect(output).not.toContain(escape);
    expect(output).toContain("terminal-fixture");
  }
  const infoOutput = stripAnsi(infoText);
  for (const text of [
    "🔗 terminal-fixture",
    "unknown:event",
    "MISSING_HOOK_ENV",
    "Readable description\nsecond\tline",
  ]) {
    expect(infoOutput).toContain(text);
  }
  expect(stripAnsi(await runHooksReport(report, ["list"]))).not.toContain("second\\tline");
  expect(
    JSON.parse(await runHooksReport(report, ["info", "terminal-fixture", "--json"])).emoji,
  ).toBe(untrusted("🔗"));
  expect(entry?.emoji).toBe(untrusted("🔗"));
});

describe("hooks cli formatting", () => {
  it.each<
    [args: string, overrides: Partial<HookStatusEntry>, includes: string[], excludes?: string[]]
  >([
    ["list --verbose", eventlessHook, ["0/1 ready", "no events defined"], ["missing requirements"]],
    [
      "list --verbose",
      {
        enabledByConfig: false,
        loadable: false,
        blockedReason: "workspace hook (disabled by default)",
      },
      ["disabled"],
      ["workspace hook"],
    ],
    [
      "list",
      { source: "openclaw-plugin", pluginId: "voice-call", managedByPlugin: true },
      ["plugin:voice-call"],
    ],
    [
      "info session-memory",
      eventlessHook,
      ["No events defined", "Blocked reason: no events defined"],
      ["Missing requirements"],
    ],
    [
      "info session-memory",
      {
        requirementsSatisfied: false,
        loadable: false,
        blockedReason: "missing requirements",
        requirements: { ...hook.requirements, env: ["DEMO_HOOK_TOKEN"] },
        missing: { ...hook.missing, env: ["DEMO_HOOK_TOKEN"] },
      },
      ["Missing requirements", "DEMO_HOOK_TOKEN"],
    ],
    [
      "info typo-hook",
      { name: "typo-hook", events: ["command:nwe", "command:new"], unknownEvents: ["command:nwe"] },
      ["Event not emitted by core (likely typo): command:nwe"],
    ],
    ["check", eventlessHook, ["Ready: 0", "Not ready: 1", "session-memory - no events defined"]],
  ])("formats %s with %j", async (args, overrides, includes, excludes = []) => {
    const output = await runHooksReport(withHook(overrides), args.split(" "));
    for (const text of includes) {
      expect(output).toContain(text);
    }
    for (const text of excludes) {
      expect(output).not.toContain(text);
    }
  });

  it("classifies eventless hooks as not eligible in JSON check output", async () => {
    const output = JSON.parse(await runHooksReport(eventless, ["check", "--json"]));

    expect(output).toMatchObject({
      total: 1,
      eligible: 0,
      notEligible: 1,
      hooks: {
        eligible: [],
        notEligible: [{ name: "session-memory", blockedReason: "no events defined" }],
      },
    });
  });

  it.each([
    {
      args: ["install", "npm:demo-hooks", "--force"],
      mock: runPluginInstallCommandMock,
      expected: {
        raw: "npm:demo-hooks",
        allowInstallPolicyWarningPrompt: true,
        opts: expect.objectContaining({ force: true, acknowledgeInstallPolicyWarning: true }),
        invalidateRuntimeCache: false,
      },
    },
    {
      args: ["update", "demo-hooks"],
      mock: runPluginUpdateCommandMock,
      expected: {
        ids: ["demo-hooks"],
        opts: expect.objectContaining({ acknowledgeInstallPolicyWarning: true }),
      },
    },
  ])(
    "forwards install-policy acknowledgement through deprecated $args",
    async ({ args, mock, expected }) => {
      mock.mockResolvedValueOnce(undefined);
      await hooksProgram().parseAsync(["hooks", ...args, "--acknowledge-install-policy-warning"], {
        from: "user",
      });
      expect(mock).toHaveBeenCalledWith(expected);
    },
  );
});

it("preserves env references while disable waits for the write lock", async () => {
  await withOpenClawTestState(
    {
      label: "hook-write-env",
      env: { OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1", OPENCLAW_TEST_HOOK_PREFIX: "before-lock" },
    },
    async (state) => {
      const hookDir = path.join(state.workspaceDir, "hooks", "fixture-hook");
      await fs.mkdir(hookDir, { recursive: true });
      await fs.writeFile(
        path.join(hookDir, "HOOK.md"),
        '---\nname: fixture-hook\ndescription: Fixture hook\nmetadata: {"openclaw":{"events":["command:new"]}}\n---\n',
      );
      await fs.writeFile(path.join(hookDir, "handler.js"), "export default async function () {}\n");
      await state.writeConfig({
        messages: { responsePrefix: "${OPENCLAW_TEST_HOOK_PREFIX}" },
        agents: hookAgent(state.workspaceDir),
        hooks: { internal: { enabled: true, entries: { "fixture-hook": { enabled: true } } } },
      });
      const raw = await fs.readFile(state.configPath, "utf8");
      const program = hooksProgram();
      await withContendedConfigMutation(
        state.configPath,
        () =>
          program.parseAsync(["hooks", "disable", "fixture-hook", "--agent", "fixture"], {
            from: "user",
          }),
        async () => {
          expect(await fs.readFile(state.configPath, "utf8")).toBe(raw);
          process.env.OPENCLAW_TEST_HOOK_PREFIX = "after-lock";
        },
      );
      expect(JSON.parse(await fs.readFile(state.configPath, "utf8"))).toMatchObject({
        messages: { responsePrefix: "${OPENCLAW_TEST_HOOK_PREFIX}" },
        hooks: { internal: { entries: { "fixture-hook": { enabled: false } } } },
      });
      expect(await config.readConfigFileSnapshot()).toMatchObject({
        valid: true,
        sourceConfig: { messages: { responsePrefix: "after-lock" } },
      });
    },
  );
});
