import { Command } from "commander";
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { HookStatusReport } from "../hooks/hooks-status.js";
import { formatHooksCheck, formatHooksList } from "./hooks-cli.js";
import { createEmptyInstallChecks } from "./requirements-test-fixtures.js";

/* ── mocks for hooks update tests ── */
const updateMocks = vi.hoisted(() => ({
  runtime: {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn(() => {
      throw new Error("exit");
    }),
  },
  loadConfig: vi.fn(),
}));

vi.mock("../runtime.js", () => ({ defaultRuntime: updateMocks.runtime }));
vi.mock("../config/io.js", () => ({
  loadConfig: updateMocks.loadConfig,
  writeConfigFile: vi.fn(),
}));

const { registerHooksCli } = await import("./hooks-cli.js");

const report: HookStatusReport = {
  workspaceDir: "/tmp/workspace",
  managedHooksDir: "/tmp/hooks",
  hooks: [
    {
      name: "session-memory",
      description: "Save session context to memory",
      source: "openclaw-bundled",
      pluginId: undefined,
      filePath: "/tmp/hooks/session-memory/HOOK.md",
      baseDir: "/tmp/hooks/session-memory",
      handlerPath: "/tmp/hooks/session-memory/handler.js",
      hookKey: "session-memory",
      emoji: "💾",
      homepage: "https://docs.openclaw.ai/automation/hooks#session-memory",
      events: ["command:new"],
      always: false,
      disabled: false,
      eligible: true,
      managedByPlugin: false,
      ...createEmptyInstallChecks(),
    },
  ],
};

describe("hooks cli formatting", () => {
  it("labels hooks list output", () => {
    const output = formatHooksList(report, {});
    expect(output).toContain("Hooks");
    expect(output).not.toContain("Internal Hooks");
  });

  it("labels hooks status output", () => {
    const output = formatHooksCheck(report, {});
    expect(output).toContain("Hooks Status");
  });

  it("labels plugin-managed hooks with plugin id", () => {
    const pluginReport: HookStatusReport = {
      workspaceDir: "/tmp/workspace",
      managedHooksDir: "/tmp/hooks",
      hooks: [
        {
          name: "plugin-hook",
          description: "Hook from plugin",
          source: "openclaw-plugin",
          pluginId: "voice-call",
          filePath: "/tmp/hooks/plugin-hook/HOOK.md",
          baseDir: "/tmp/hooks/plugin-hook",
          handlerPath: "/tmp/hooks/plugin-hook/handler.js",
          hookKey: "plugin-hook",
          emoji: "🔗",
          homepage: undefined,
          events: ["command:new"],
          always: false,
          disabled: false,
          eligible: true,
          managedByPlugin: true,
          ...createEmptyInstallChecks(),
        },
      ],
    };

    const output = formatHooksList(pluginReport, {});
    expect(output).toContain("plugin:voice-call");
  });
});

describe("hooks update --all with no npm-installed hooks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("exits cleanly with a friendly message when --all is passed but no npm-installed hooks exist", async () => {
    updateMocks.loadConfig.mockReturnValue({ hooks: { internal: { installs: {} } } });

    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${String(code)})`);
    }) as typeof process.exit);

    const program = new Command();
    program.exitOverride();
    registerHooksCli(program);

    await program.parseAsync(["hooks", "update", "--all"], { from: "user" });

    expect(updateMocks.runtime.log).toHaveBeenCalledWith("No npm-installed hooks to update.");
    expect(updateMocks.runtime.error).not.toHaveBeenCalled();
    expect(exitSpy).not.toHaveBeenCalled();

    exitSpy.mockRestore();
  });
});
