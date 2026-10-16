import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveInstallationTarget } from "../infra/installation-target-context.js";
import { readRestartSentinelReadOnly, writeRestartSentinel } from "../infra/restart-sentinel.js";
import type { UpdateRunResult } from "../infra/update-runner-types.js";
import { withEnvAsync } from "../test-utils/env.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { triageCommand } from "./triage.js";
import { createTriageRuntime, withTriageTerminal } from "./triage.test-support.js";

const mocks = vi.hoisted(() => ({
  collectDoctorFindings: vi.fn(),
  writeDiagnosticSupportExport: vi.fn(),
  resolveExecutablePath: vi.fn(),
  runUtf8CommandWithTimeout: vi.fn(),
  spawn: vi.fn(),
}));

vi.mock("@clack/prompts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@clack/prompts")>()),
  confirm: async () => true,
}));

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: mocks.spawn,
}));
vi.mock("./doctor-lint-runner.js", () => ({ collectDoctorFindings: mocks.collectDoctorFindings }));
vi.mock("../logging/diagnostic-support-export.js", () => ({
  writeDiagnosticSupportExport: mocks.writeDiagnosticSupportExport,
}));
vi.mock("../infra/executable-path.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/executable-path.js")>()),
  resolveExecutablePath: mocks.resolveExecutablePath,
}));
vi.mock("../process/exec.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../process/exec.js")>()),
  runUtf8CommandWithTimeout: mocks.runUtf8CommandWithTimeout,
}));

const agents = [
  "codex",
  "claude",
  "pi",
  "opencode",
  "muse",
  "grok",
  "cursor",
  "kimi",
  "qwen",
  "agy",
] as const;
const secret = "sk-test-triage-recovery-secret-1234567890";

function runTriage(
  runtime: ReturnType<typeof createTriageRuntime>,
  options: Parameters<typeof triageCommand>[1] = {},
  terminal = true,
) {
  return withTriageTerminal(terminal, () => triageCommand(runtime, { noExport: true, ...options }));
}
function recovery(state: OpenClawTestState) {
  return {
    target: resolveInstallationTarget(),
    cwd: state.workspaceDir,
    updateFailure: { result: failedUpdate(state.statePath("install")) },
  };
}
function spawnOptions(cwd: string, target: ReturnType<typeof resolveInstallationTarget>) {
  return expect.objectContaining({
    stdio: "inherit",
    cwd,
    env: expect.objectContaining({
      OPENCLAW_STATE_DIR: target.stateDir,
      OPENCLAW_CONFIG_PATH: target.configPath,
      OPENCLAW_WORKSPACE_DIR: target.defaultWorkspaceDir,
    }),
  });
}

function failedUpdate(root: string): UpdateRunResult {
  return {
    status: "error",
    mode: "npm",
    root,
    reason: "injected-doctor-failure",
    before: { version: "2026.8.25" },
    after: { version: "2026.8.26" },
    recovery: { serviceRestartSafe: false, reason: "runtime-verification-failed" },
    steps: [
      {
        name: "doctor",
        command: "openclaw doctor --fix",
        cwd: root,
        exitCode: 1,
        durationMs: 12,
        stderrTail: `${"🦞".repeat(600)} Migration failed at ${root}/runtime-entry.js; Authorization: Bearer ${secret}`,
        stdoutTail: "compiler-output-cause",
      },
    ],
    durationMs: 15,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.collectDoctorFindings.mockResolvedValue([]);
  mocks.resolveExecutablePath.mockImplementation((agent: string) => `/usr/local/bin/${agent}`);
  mocks.runUtf8CommandWithTimeout.mockImplementation(async (argv, options) => {
    if (argv.at(-1) === "--help") {
      return { stdout: "--safe-mode", stderr: "", code: 0, termination: "exit" };
    }
    const actual = await vi.importActual<typeof import("../process/exec.js")>("../process/exec.js");
    return await actual.runUtf8CommandWithTimeout(argv, options);
  });
  mocks.spawn.mockImplementation(() => {
    const child = new EventEmitter();
    queueMicrotask(() => child.emit("exit", 0, null));
    return child;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("triage external recovery handoff", () => {
  it.each(["kimi", "agy"] as const)(
    "starts the first available agent %s immediately",
    async (agent) => {
      const available = new Set<string>(
        agents
          .slice(agents.indexOf(agent))
          .map((name) => (name === "cursor" ? "cursor-agent" : name)),
      );
      mocks.resolveExecutablePath.mockImplementation((binary: string) =>
        available.has(binary) ? `/usr/local/bin/${binary}` : undefined,
      );
      const runtime = createTriageRuntime();
      await withOpenClawTestState({ layout: "split" }, async () => {
        await runTriage(runtime);
      });
      expect(mocks.spawn).toHaveBeenCalledExactlyOnceWith(
        `/usr/local/bin/${agent}`,
        agent === "agy"
          ? ["--prompt-interactive", expect.any(String)]
          : ["--prompt", expect.any(String)],
        expect.objectContaining({ stdio: "inherit" }),
      );
      if (agent === "kimi") {
        expect(runtime.log).toHaveBeenCalledWith(
          expect.stringContaining("native automatic permission policy (no approval prompts)"),
        );
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "pins state, config and custom workspace in executable, POSIX-quoted manual handoffs",
    async () => {
      await withOpenClawTestState({ layout: "split" }, async (state) => {
        const home = path.join(state.stateDir, "operator's $fixture");
        const originalState = path.join(home, ".openclaw");
        const configPath = path.join(home, "custom config.json");
        const defaultWorkspaceDir = path.join(home, "custom workspace");
        const bin = path.join(home, "bin");
        await fs.mkdir(bin, { recursive: true });
        await withEnvAsync(
          {
            HOME: home,
            OPENCLAW_HOME: home,
            OPENCLAW_STATE_DIR: undefined,
            OPENCLAW_CONFIG_PATH: undefined,
            OPENCLAW_WORKSPACE_DIR: undefined,
          },
          async () => {
            // Doctor's dotenv phase can establish the original custom selectors.
            mocks.collectDoctorFindings.mockImplementation(async () => {
              process.env.OPENCLAW_CONFIG_PATH = configPath;
              process.env.OPENCLAW_WORKSPACE_DIR = defaultWorkspaceDir;
              return [];
            });
            for (const command of [
              ...agents.map((agent) => (agent === "cursor" ? "cursor-agent" : agent)),
              "openclaw",
            ]) {
              const readPrompt =
                command === "openclaw"
                  ? ""
                  : command === "muse"
                    ? 'test "$1" = exec && test "$2" = --prompt-file && cat "$3"\n'
                    : command === "grok"
                      ? 'test "$1" = --prompt-file && cat "$2"\n'
                      : command === "kimi" || command === "agy"
                        ? 'case "$1" in --prompt|--prompt-interactive) ;; *) exit 1 ;; esac && prompt_path=${2#Read the debugging prompt at } && prompt_path=${prompt_path% and follow its repair and verification instructions.} && cat "$prompt_path"\n'
                        : "cat\n";
              await fs.writeFile(
                path.join(bin, command),
                `#!/bin/sh\nprintf "%s\\n" "$OPENCLAW_STATE_DIR" "$OPENCLAW_CONFIG_PATH" "$OPENCLAW_WORKSPACE_DIR"\n${readPrompt}`,
                { mode: 0o700 },
              );
            }
            const runtime = createTriageRuntime();
            await triageCommand(runtime, { json: true, noExport: true });
            const report = runtime.writeJson.mock.calls[0]?.[0] as {
              promptPath: string;
              suggestedCommands: string[];
            };
            const prompt = await fs.readFile(report.promptPath, "utf8");
            for (const [index, command] of report.suggestedCommands.entries()) {
              const { stdout } = await promisify(execFile)("/bin/sh", ["-c", command], {
                env: { HOME: home, PATH: `${bin}:/usr/bin:/bin` },
                timeout: 10_000,
              });
              expect(stdout).toBe(
                `${originalState}\n${configPath}\n${defaultWorkspaceDir}\n${index < agents.length ? prompt : ""}`,
              );
            }
            expect(await fs.readFile(report.promptPath, "utf8")).not.toContain(home);
            expect(process.env.OPENCLAW_STATE_DIR).toBeUndefined();
          },
        );
      });
    },
  );

  it("never launches an explicitly selected kimi in --non-interactive mode", async () => {
    await withOpenClawTestState({ layout: "split" }, async () => {
      const runtime = createTriageRuntime();
      await runTriage(runtime, { json: false, nonInteractive: true, agent: "kimi" });
      const output = runtime.log.mock.calls.flat().join("\n");
      const commands = runtime.log.mock.calls.filter(([line]) => String(line).startsWith("  "));
      expect(commands).toHaveLength(1);
      expect(commands[0]?.[0]).toContain("kimi --prompt");
      expect(output).toContain("No repair agent was started.");
      expect(mocks.spawn).not.toHaveBeenCalled();
    });
  });

  it("gives one non-interactive next action when no agent is detected", async () => {
    mocks.resolveExecutablePath.mockReturnValue(undefined);
    await withOpenClawTestState({ layout: "split" }, async () => {
      const runtime = createTriageRuntime();
      await runTriage(runtime, { nonInteractive: true });
      const output = runtime.log.mock.calls.flat().join("\n");
      const commands = runtime.log.mock.calls.filter(([line]) => String(line).startsWith("  "));
      expect(commands).toHaveLength(1);
      expect(commands[0]?.[0]).toContain("openclaw triage");
      expect(output).toContain("No repair agent was started.");
      expect(output).not.toContain("Ready-to-run agent handoffs:");
      expect(output).toContain(
        "No supported coding-agent CLI executable was found on this process's PATH.",
      );
      expect(output).toContain("If already installed, add its executable to this shell's PATH");
      expect(output).toContain("open the saved debugging prompt in an agent you already use");
      expect(mocks.spawn).not.toHaveBeenCalled();
      expect(mocks.runUtf8CommandWithTimeout).not.toHaveBeenCalled();
    });
  });

  it("runs Claude recovery without safe mode after warning when the installed CLI lacks support", async () => {
    mocks.resolveExecutablePath.mockImplementation((binary: string) =>
      binary === "claude" ? "/usr/local/bin/claude" : undefined,
    );
    mocks.runUtf8CommandWithTimeout.mockResolvedValue({
      stdout: "Usage: claude [options]",
      stderr: "",
      code: 0,
      termination: "exit",
    });
    const runtime = createTriageRuntime();

    await withOpenClawTestState({ layout: "split" }, async (state) => {
      const context = recovery(state);
      await runTriage(runtime, { recovery: context });
      const promptPath = runtime.log.mock.calls
        .map(([line]) => String(line))
        .find((line) => line.startsWith("Debugging prompt: "))!
        .slice("Debugging prompt: ".length);
      const prompt = await fs.readFile(promptPath, "utf8");
      expect(prompt).toContain("injected-doctor-failure");
      expect(mocks.spawn).toHaveBeenCalledExactlyOnceWith(
        "/usr/local/bin/claude",
        ["-p", prompt],
        spawnOptions(state.workspaceDir, context.target),
      );
    });

    expect(mocks.runUtf8CommandWithTimeout).toHaveBeenCalledWith(
      ["/usr/local/bin/claude", "--help"],
      expect.objectContaining({ timeoutMs: 10_000, killProcessTree: true }),
    );
    expect(runtime.log).toHaveBeenCalledWith(
      "Claude --safe-mode unavailable; running claude -p with normal customization settings.",
    );
    expect(runtime.error).not.toHaveBeenCalled();
    expect(runtime.exit).not.toHaveBeenCalled();
  });

  it("redacts a rejected Claude capability probe and prints the manual handoff", async () => {
    mocks.resolveExecutablePath.mockImplementation((binary: string) =>
      binary === "claude" ? "/usr/local/bin/claude" : undefined,
    );
    mocks.runUtf8CommandWithTimeout.mockRejectedValue(
      new Error(`missing interpreter; Authorization: Bearer ${secret}`),
    );
    const runtime = createTriageRuntime();

    await withOpenClawTestState({ layout: "split" }, async () => {
      await expect(runTriage(runtime)).rejects.toMatchObject({ code: 1 });
    });

    expect(mocks.spawn).not.toHaveBeenCalled();
    expect(runtime.error).toHaveBeenCalledWith(
      expect.stringContaining("Failed to check Claude safe-mode support: missing interpreter"),
    );
    expect(runtime.log).toHaveBeenCalledWith(expect.stringContaining("Run manually:"));
    expect(JSON.stringify([runtime.error.mock.calls, runtime.log.mock.calls])).not.toContain(
      secret,
    );
  });

  it("reports missing cursor without falling back to an available agent", async () => {
    mocks.resolveExecutablePath.mockImplementation((binary: string) =>
      binary === "claude" ? "/usr/local/bin/claude" : undefined,
    );
    await withOpenClawTestState({ layout: "split" }, async () => {
      const runtime = createTriageRuntime();
      await expect(runTriage(runtime, { agent: "cursor" })).rejects.toMatchObject({ code: 1 });
      expect(runtime.error).toHaveBeenCalledWith(
        "cursor is not found or unavailable for direct launch on PATH.",
      );
      expect(runtime.log).toHaveBeenCalledWith(
        "No Cursor Agent (cursor-agent) CLI executable was found on this process's PATH.",
      );
      expect(runtime.exit).toHaveBeenCalledWith(1);
      expect(mocks.spawn).not.toHaveBeenCalled();
    });
  });

  it("launches recovery from the captured target without fresh Doctor or export enrichment", async () => {
    mocks.collectDoctorFindings.mockRejectedValue(
      new Error(`Doctor import unavailable; token=${secret}`),
    );
    mocks.writeDiagnosticSupportExport.mockRejectedValue(
      new Error("Diagnostics chunk unavailable"),
    );
    await withOpenClawTestState({ layout: "split" }, async (state) => {
      const target = resolveInstallationTarget();
      const update = failedUpdate(state.statePath("install"));
      const doctorStep = update.steps[0]!;
      update.steps = [
        ...["older-failure", "recent-failure", "latest-failure"].map((name) =>
          Object.assign({}, doctorStep, { name }),
        ),
        doctorStep,
        { ...doctorStep, name: "successful-step", exitCode: 0 },
        {
          ...doctorStep,
          name: "interrupted-step",
          exitCode: null,
          termination: "signal",
          stderrTail: "Update child terminated before reporting an exit code",
        },
        {
          ...doctorStep,
          name: "advisory-step",
          advisory: { kind: "package-post-install-doctor", message: "Recoverable Doctor advice" },
        },
      ];
      const runtime = createTriageRuntime();
      await withTriageTerminal(true, () =>
        triageCommand(runtime, {
          recovery: { target, cwd: state.workspaceDir, updateFailure: { result: update } },
        }),
      );
      expect(mocks.spawn).toHaveBeenCalledExactlyOnceWith(
        "/usr/local/bin/codex",
        [expect.any(String)],
        spawnOptions(state.workspaceDir, target),
      );
      const prompt = String(mocks.spawn.mock.calls[0]?.[1]?.[0]);
      expect(prompt).toContain("injected-doctor-failure");
      expect(prompt).toContain("2026.8.25");
      expect(prompt).toContain("2026.8.26");
      expect(mocks.collectDoctorFindings).not.toHaveBeenCalled();
      expect(mocks.writeDiagnosticSupportExport).not.toHaveBeenCalled();
      expect(prompt).toMatch(/Doctor checks deferred/iu);
      expect(prompt).toMatch(/Diagnostics export deferred/iu);
      expect(prompt).not.toContain("with `--no-export`");
      const details = /```json\n([\s\S]+?)\n```/u.exec(prompt)?.[1] ?? "";
      expect(JSON.parse(details)).toMatchObject({
        result: {
          recovery: { serviceRestartSafe: false },
          steps: [
            { name: "latest-failure", exitCode: 1 },
            {
              name: "doctor",
              exitCode: 1,
              stderrTail: expect.stringContaining(
                "Migration failed at $OPENCLAW_STATE_DIR/install/runtime-entry.js",
              ),
              stdoutTail: "compiler-output-cause",
            },
            {
              name: "interrupted-step",
              exitCode: null,
              termination: "signal",
              stderrTail: "Update child terminated before reporting an exit code",
            },
          ],
        },
      });
      expect(Buffer.byteLength(details)).toBeLessThanOrEqual(4 * 1024);
      expect(prompt).toMatch(/autonomously/iu);
      expect(prompt).toMatch(/preserve.*(?:state|history|database)/iu);
      expect(prompt).not.toContain(secret);
      expect(prompt).not.toContain(state.stateDir);
      expect(prompt).not.toContain("\uFFFD");
      expect(Buffer.byteLength(prompt)).toBeLessThanOrEqual(8 * 1024);
      expect(runtime.exit).not.toHaveBeenCalled();
    });
  });

  it("launches native recovery when the prompt artifact writeFile is denied", async () => {
    await withOpenClawTestState({ layout: "split" }, async (state) => {
      const context = recovery(state);
      await fs.access(context.target.stateDir);
      await fs.access(state.home);
      const artifactError = Object.assign(
        new Error(`EACCES: support artifact permission denied; token=${secret}`),
        { code: "EACCES" },
      );
      vi.spyOn(fs, "writeFile").mockRejectedValue(artifactError);
      const runtime = createTriageRuntime();

      await runTriage(runtime, { recovery: context });

      expect(mocks.spawn).toHaveBeenCalledExactlyOnceWith(
        "/usr/local/bin/codex",
        [expect.stringContaining("injected-doctor-failure")],
        expect.objectContaining({ cwd: state.workspaceDir, stdio: "inherit" }),
      );
      const output = JSON.stringify([runtime.log.mock.calls, runtime.error.mock.calls]);
      expect(output).toContain("EACCES");
      expect(output).not.toContain(secret);
      expect(runtime.log).not.toHaveBeenCalledWith(expect.stringMatching(/^Debugging prompt: /u));
      expect(runtime.exit).not.toHaveBeenCalled();
    });
  });

  it("keeps prompt artifact failure explicit without interactive handoff in non-TTY mode", async () => {
    await withOpenClawTestState({ layout: "split" }, async (state) => {
      const target = resolveInstallationTarget();
      vi.spyOn(fs, "writeFile").mockRejectedValue(
        Object.assign(new Error("EACCES: support artifact permission denied"), {
          code: "EACCES",
        }),
      );
      const runtime = createTriageRuntime();

      await expect(
        runTriage(
          runtime,
          {
            json: false,
            nonInteractive: false,
            recovery: {
              target,
              updateFailure: { result: failedUpdate(state.statePath("install")) },
            },
          },
          false,
        ),
      ).rejects.toMatchObject({ code: "EACCES" });

      expect(runtime.writeJson).not.toHaveBeenCalled();
      expect(mocks.spawn).not.toHaveBeenCalled();
    });
  });
});

describe("standalone triage update evidence", () => {
  it("reads a failed skipped sentinel without consuming it or exposing routing instructions", async () => {
    await withOpenClawTestState({ layout: "split" }, async (state) => {
      const saved = await writeRestartSentinel({
        kind: "update",
        status: "skipped",
        ts: 1,
        sessionKey: "private-session-route",
        message: "private-operator-note",
        continuation: { kind: "agentTurn", message: "untrusted-continuation-instruction" },
        stats: {
          mode: "npm",
          root: state.statePath("install"),
          reason: "dirty",
          before: { version: "2026.8.25", unrelated: "private-before-metadata" },
          after: { version: "2026.8.26", instructions: "untrusted-version-instruction" },
          steps: [
            {
              name: "doctor",
              command: "openclaw doctor --fix",
              log: {
                exitCode: 1,
                stderrTail: " \n",
                stdoutTail: `EACCES: cannot open ${state.statePath("install", "runtime-entry.js")} token=${secret}`,
              },
            },
          ],
        },
      });
      const runtime = createTriageRuntime();
      await triageCommand(runtime, { json: true, noExport: true });
      const prompt = await fs.readFile(runtime.writeJson.mock.calls[0]?.[0]?.promptPath, "utf8");
      expect(prompt).toContain("dirty");
      expect(prompt).toContain("2026.8.26");
      const evidence = JSON.parse(/```json\n([\s\S]+?)\n```/u.exec(prompt)?.[1] ?? "");
      expect(evidence.result.recovery).toBeUndefined();
      expect(prompt).toContain("EACCES: cannot open $OPENCLAW_STATE_DIR/install/runtime-entry.js");
      for (const omitted of [
        secret,
        "private-session-route",
        "private-operator-note",
        "untrusted-continuation-instruction",
        "private-before-metadata",
        "untrusted-version-instruction",
      ]) {
        expect(prompt).not.toContain(omitted);
      }
      expect(await readRestartSentinelReadOnly()).toEqual(saved);
    });
  });

  it("does not project a skipped/managed-service-handoff-started notification as a failed update", async () => {
    await withOpenClawTestState({ layout: "split" }, async () => {
      await writeRestartSentinel({
        kind: "update",
        status: "skipped",
        ts: 1,
        stats: { reason: "managed-service-handoff-started" },
      });
      const runtime = createTriageRuntime();
      await triageCommand(runtime, { json: true, noExport: true });
      const prompt = await fs.readFile(runtime.writeJson.mock.calls[0]?.[0]?.promptPath, "utf8");
      expect(prompt).not.toContain("managed-service-handoff-started");
    });
  });
});
