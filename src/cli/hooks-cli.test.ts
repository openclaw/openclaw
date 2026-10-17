import fs from "node:fs/promises";
import path from "node:path";
import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { withContendedConfigMutation } from "../../test/helpers/config-mutation-lock.js";
import { readConfigFileSnapshot } from "../config/config.js";
import type { HookStatusEntry, HookStatusReport } from "../hooks/hooks-status.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { makeHookStatusEntry } from "./cli-fixtures.test-support.js";
import { formatHookInfo, formatHooksCheck, formatHooksList } from "./hooks-cli.format.js";
import { registerHooksCli } from "./hooks-cli.js";

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
const eventless = withHook({ events: [], loadable: false, blockedReason: "no events defined" });
const list = (overrides: Partial<HookStatusEntry>, verbose = true) =>
  formatHooksList(withHook(overrides), { verbose });
const info = (overrides: Partial<HookStatusEntry>) =>
  formatHookInfo({ ...hook, ...overrides }, overrides.name ?? hook.name, {});

function hooksProgram() {
  const program = new Command().enablePositionalOptions().exitOverride();
  registerHooksCli(program);
  return program;
}

beforeEach(() => {
  runPluginInstallCommandMock.mockReset();
  runPluginUpdateCommandMock.mockReset();
});

describe("hooks cli formatting", () => {
  it.each<[name: string, render: () => string, includes: string[], excludes?: string[]]>([
    [
      "eventless list",
      () => formatHooksList(eventless, { verbose: true }),
      ["0/1 ready", "no events defined"],
      ["missing requirements"],
    ],
    [
      "disabled list",
      () =>
        list({
          enabledByConfig: false,
          loadable: false,
          blockedReason: "workspace hook (disabled by default)",
        }),
      ["disabled"],
      ["workspace hook"],
    ],
    [
      "plugin-managed list",
      () =>
        list({ source: "openclaw-plugin", pluginId: "voice-call", managedByPlugin: true }, false),
      ["plugin:voice-call"],
    ],
    [
      "eventless info",
      () => formatHookInfo(eventless.hooks[0], "session-memory", {}),
      ["No events defined", "Blocked reason: no events defined"],
      ["Missing requirements"],
    ],
    [
      "missing requirements info",
      () =>
        info({
          requirementsSatisfied: false,
          loadable: false,
          blockedReason: "missing requirements",
          requirements: { ...hook.requirements, env: ["DEMO_HOOK_TOKEN"] },
          missing: { ...hook.missing, env: ["DEMO_HOOK_TOKEN"] },
        }),
      ["Missing requirements", "DEMO_HOOK_TOKEN"],
    ],
    [
      "unknown events info",
      () =>
        info({
          name: "typo-hook",
          events: ["command:nwe", "command:new"],
          unknownEvents: ["command:nwe"],
        }),
      ["Event not emitted by core (likely typo): command:nwe"],
    ],
    [
      "eventless check",
      () => formatHooksCheck(eventless, {}),
      ["Ready: 0", "Not ready: 1", "session-memory - no events defined"],
    ],
  ])("formats %s", (_name, render, includes, excludes = []) => {
    const output = render();
    for (const text of includes) {
      expect(output).toContain(text);
    }
    for (const text of excludes) {
      expect(output).not.toContain(text);
    }
  });

  it("classifies eventless hooks as not eligible in JSON check output", () => {
    const output = JSON.parse(formatHooksCheck(eventless, { json: true }));

    expect(output).toMatchObject({
      total: 1,
      eligible: 0,
      notEligible: 1,
      hooks: {
        eligible: [],
        notEligible: [
          {
            name: "session-memory",
            blockedReason: "no events defined",
          },
        ],
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
        agents: {
          ownership: "explicit",
          entries: { fixture: { workspace: state.workspaceDir } },
          defaults: { systemAgent: { agentId: "fixture" } },
        },
        hooks: {
          internal: {
            enabled: true,
            entries: { "fixture-hook": { enabled: true } },
          },
        },
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
      expect(await readConfigFileSnapshot()).toMatchObject({
        valid: true,
        sourceConfig: { messages: { responsePrefix: "after-lock" } },
      });
    },
  );
});
