import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveInstallationTarget } from "../infra/installation-target-context.js";
import { readRestartSentinelReadOnly, writeRestartSentinel } from "../infra/restart-sentinel.js";
import { tryAcquireExclusiveSqliteCoordinator } from "../infra/sqlite-coordinator.js";
import { acquireGatewayLifecycleCoordinator } from "../infra/state-database-coordinator.js";
import { readUpdateRunDriver } from "../infra/update-run-driver.js";
import { createUpdateRun } from "../infra/update-run-ledger.js";
import type { UpdateRunResult } from "../infra/update-runner-types.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { triageCommand } from "./triage.js";
import { createTriageRuntime, withTriageTerminal } from "./triage.test-support.js";

const mocks = vi.hoisted(() => ({
  collectDoctorFindings: vi.fn(),
  writeDiagnosticSupportExport: vi.fn(),
  resolveExecutablePath: vi.fn(),
  runUtf8CommandWithTimeout: vi.fn(),
  spawn: vi.fn(),
  readActiveGatewayLockIdentity: vi.fn(),
}));

vi.mock("@clack/prompts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@clack/prompts")>()),
  confirm: async () => true,
}));

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: mocks.spawn,
}));
vi.mock("./doctor-lint.js", () => ({ collectDoctorFindings: mocks.collectDoctorFindings }));
vi.mock("../logging/diagnostic-support-export.js", () => ({
  writeDiagnosticSupportExport: mocks.writeDiagnosticSupportExport,
}));
vi.mock("../infra/executable-path.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/executable-path.js")>()),
  resolveExecutablePath: mocks.resolveExecutablePath,
}));
vi.mock("../infra/gateway-lock.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/gateway-lock.js")>()),
  readActiveGatewayLockIdentity: mocks.readActiveGatewayLockIdentity,
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
] as const;
const printOnlyModes = [
  { mode: "JSON", json: true, nonInteractive: false, terminal: true },
  { mode: "--non-interactive", json: false, nonInteractive: true, terminal: true },
  { mode: "non-TTY", json: false, nonInteractive: false, terminal: false },
] as const;
const secret = "sk-test-triage-recovery-secret-1234567890";

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
  mocks.readActiveGatewayLockIdentity.mockResolvedValue(undefined);
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
  it.each(
    ["first available", "explicit"].flatMap((selection) =>
      agents.map((agent) => ({ agent, selection })),
    ),
  )("starts the $selection agent $agent immediately", async ({ agent, selection }) => {
    const explicit = selection === "explicit";
    const available = new Set<string>(
      (explicit ? agents : agents.slice(agents.indexOf(agent))).map((name) =>
        name === "cursor" ? "cursor-agent" : name,
      ),
    );
    mocks.resolveExecutablePath.mockImplementation((binary: string) =>
      available.has(binary) ? `/usr/local/bin/${binary}` : undefined,
    );
    const runtime = createTriageRuntime();
    await withOpenClawTestState({ layout: "split" }, async () => {
      await withTriageTerminal(true, () =>
        triageCommand(runtime, {
          noExport: true,
          agent: explicit ? agent : undefined,
        }),
      );
    });
    expect(mocks.spawn).toHaveBeenCalledExactlyOnceWith(
      `/usr/local/bin/${agent === "cursor" ? "cursor-agent" : agent}`,
      agent === "claude"
        ? ["--safe-mode", expect.any(String)]
        : agent === "qwen"
          ? ["--prompt-interactive", expect.any(String)]
          : agent === "opencode" || agent === "kimi"
            ? ["--prompt", expect.any(String)]
            : [expect.any(String)],
      expect.objectContaining({ stdio: "inherit" }),
    );
    if (agent === "kimi") {
      expect(runtime.log).toHaveBeenCalledWith(
        expect.stringContaining("native automatic permission policy (no approval prompts)"),
      );
    }
  });

  it.skipIf(process.platform === "win32").each(["default", "custom"])(
    "pins state, config and %s workspace in executable, POSIX-quoted manual handoffs",
    async (workspaceSelector) => {
      await withOpenClawTestState({ layout: "split" }, async (state) => {
        const home = path.join(state.stateDir, "operator's $fixture");
        const originalState = path.join(home, ".openclaw");
        const configPath = path.join(home, "custom config.json");
        const defaultWorkspaceDir =
          workspaceSelector === "custom"
            ? path.join(home, "custom workspace")
            : path.join(originalState, "workspace");
        const bin = path.join(home, "bin");
        await fs.mkdir(bin, { recursive: true });
        vi.stubEnv("HOME", home);
        vi.stubEnv("OPENCLAW_HOME", home);
        vi.stubEnv("OPENCLAW_STATE_DIR", undefined);
        vi.stubEnv("OPENCLAW_CONFIG_PATH", undefined);
        vi.stubEnv("OPENCLAW_WORKSPACE_DIR", undefined);
        // Doctor's dotenv phase can establish the original custom selectors.
        mocks.collectDoctorFindings.mockImplementation(async () => {
          process.env.OPENCLAW_CONFIG_PATH = configPath;
          if (workspaceSelector === "custom") {
            process.env.OPENCLAW_WORKSPACE_DIR = defaultWorkspaceDir;
          }
          return [];
        });
        for (const command of [
          "claude",
          "codex",
          "cursor-agent",
          "grok",
          "kimi",
          "muse",
          "opencode",
          "pi",
          "qwen",
          "openclaw",
        ]) {
          const readPrompt =
            command === "openclaw"
              ? ""
              : command === "muse"
                ? 'test "$1" = exec && test "$2" = --prompt-file && cat "$3"\n'
                : command === "grok"
                  ? 'test "$1" = --prompt-file && cat "$2"\n'
                  : command === "kimi"
                    ? 'test "$1" = --prompt && prompt_path=${2#Read the debugging prompt at } && prompt_path=${prompt_path% and follow its repair and verification instructions.} && cat "$prompt_path"\n'
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
      });
    },
  );

  it.each(
    printOnlyModes.flatMap((mode) =>
      (
        [
          { agent: "opencode", command: "opencode run" },
          { agent: "muse", command: "muse exec --prompt-file" },
          { agent: "grok", command: "grok --prompt-file" },
          { agent: "cursor", command: "cursor-agent --print" },
          { agent: "kimi", command: "kimi --prompt" },
          { agent: "qwen", command: "qwen" },
        ] as const
      ).map((agent) => Object.assign({}, mode, agent)),
    ),
  )(
    "never launches an explicitly selected $agent in $mode mode",
    async ({ json, nonInteractive, terminal, agent, command }) => {
      await withOpenClawTestState({ layout: "split" }, async () => {
        const runtime = createTriageRuntime();
        await withTriageTerminal(terminal, () =>
          triageCommand(runtime, { json, nonInteractive, noExport: true, agent }),
        );
        if (json) {
          expect(runtime.writeJson).toHaveBeenCalledWith(
            expect.objectContaining({
              detectedAgents: agents,
              suggestedCommands: expect.arrayContaining([
                expect.stringContaining("opencode run"),
                expect.stringContaining("pi --print"),
                expect.stringContaining("muse exec --prompt-file"),
                expect.stringContaining("grok --prompt-file"),
                expect.stringContaining("cursor-agent --print"),
                expect.stringContaining("kimi --prompt"),
                expect.stringContaining("qwen"),
              ]),
            }),
            2,
          );
          expect(runtime.writeJson.mock.calls[0]?.[0].suggestedCommands).toHaveLength(10);
        } else {
          const output = runtime.log.mock.calls.flat().join("\n");
          const commands = runtime.log.mock.calls.filter(([line]) => String(line).startsWith("  "));
          expect(commands).toHaveLength(1);
          expect(commands[0]?.[0]).toContain(command);
          expect(output).toContain("No repair agent was started.");
        }
        expect(mocks.spawn).not.toHaveBeenCalled();
      });
    },
  );

  it.each(["claude", "codex", undefined] as const)(
    "gives one non-interactive next action when the detected agent is %s",
    async (agent) => {
      mocks.resolveExecutablePath.mockImplementation((binary: string) =>
        binary === agent ? `/usr/local/bin/${binary}` : undefined,
      );
      await withOpenClawTestState({ layout: "split" }, async () => {
        const runtime = createTriageRuntime();
        await withTriageTerminal(true, () =>
          triageCommand(runtime, { nonInteractive: true, noExport: true }),
        );
        const output = runtime.log.mock.calls.flat().join("\n");
        const commands = runtime.log.mock.calls.filter(([line]) => String(line).startsWith("  "));
        expect(commands).toHaveLength(1);
        expect(commands[0]?.[0]).toContain(
          agent === "claude" ? "claude -p" : agent === "codex" ? "codex exec" : "openclaw triage",
        );
        expect(output).toContain("No repair agent was started.");
        expect(output).not.toContain("Ready-to-run agent handoffs:");
        if (!agent) {
          expect(output).toContain("Install Claude Code or Codex");
        }
        expect(mocks.spawn).not.toHaveBeenCalled();
        expect(mocks.runUtf8CommandWithTimeout).not.toHaveBeenCalled();
      });
    },
  );

  it("prints a manual handoff instead of launching Claude without safe-mode support", async () => {
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

    await withOpenClawTestState({ layout: "split" }, async () => {
      await withTriageTerminal(true, async () => {
        await expect(triageCommand(runtime, { noExport: true })).rejects.toMatchObject({ code: 1 });
      });
    });

    expect(mocks.spawn).not.toHaveBeenCalled();
    expect(mocks.runUtf8CommandWithTimeout).toHaveBeenCalledWith(
      ["/usr/local/bin/claude", "--help"],
      expect.objectContaining({ timeoutMs: 10_000, killProcessTree: true }),
    );
    expect(runtime.error).toHaveBeenCalledWith(expect.stringContaining("Claude Code 2.1.169+"));
    expect(runtime.log).toHaveBeenCalledWith(expect.stringContaining("Run without safe mode:"));
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
      await withTriageTerminal(true, async () => {
        await expect(triageCommand(runtime, { noExport: true })).rejects.toMatchObject({ code: 1 });
      });
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

  it.each(["pi", "muse", "grok", "cursor", "kimi", "qwen"] as const)(
    "reports missing %s without falling back to an available agent",
    async (agent) => {
      mocks.resolveExecutablePath.mockImplementation((binary: string) =>
        binary === "claude" ? "/usr/local/bin/claude" : undefined,
      );
      await withOpenClawTestState({ layout: "split" }, async () => {
        const runtime = createTriageRuntime();
        await expect(
          withTriageTerminal(true, () => triageCommand(runtime, { noExport: true, agent })),
        ).rejects.toMatchObject({ code: 1 });
        expect(runtime.error).toHaveBeenCalledWith(
          `${agent} is not found or unavailable for direct launch on PATH.`,
        );
        expect(runtime.log).toHaveBeenCalledWith(
          `Install ${agent === "cursor" ? "Cursor Agent (cursor-agent)" : agent} on PATH, then run triage again.`,
        );
        expect(runtime.exit).toHaveBeenCalledWith(1);
        expect(mocks.spawn).not.toHaveBeenCalled();
      });
    },
  );

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
        expect.objectContaining({
          cwd: state.workspaceDir,
          stdio: "inherit",
          env: expect.objectContaining({
            OPENCLAW_STATE_DIR: target.stateDir,
            OPENCLAW_CONFIG_PATH: target.configPath,
            OPENCLAW_WORKSPACE_DIR: target.defaultWorkspaceDir,
          }),
        }),
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

  it.each(["mkdir", "writeFile"] as const)(
    "launches native recovery when the prompt artifact %s is denied",
    async (operation) => {
      await withOpenClawTestState({ layout: "split" }, async (state) => {
        const target = resolveInstallationTarget();
        await fs.access(target.stateDir);
        await fs.access(state.home);
        const artifactError = Object.assign(
          new Error(`EACCES: support artifact permission denied; token=${secret}`),
          { code: "EACCES" },
        );
        vi.spyOn(fs, operation).mockRejectedValue(artifactError);
        const runtime = createTriageRuntime();

        await withTriageTerminal(true, () =>
          triageCommand(runtime, {
            noExport: true,
            recovery: {
              target,
              cwd: state.workspaceDir,
              updateFailure: { result: failedUpdate(state.statePath("install")) },
            },
          }),
        );

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
    },
  );

  it.each(printOnlyModes)(
    "keeps prompt artifact failure explicit without interactive handoff in $mode mode",
    async ({ json, nonInteractive, terminal }) => {
      await withOpenClawTestState({ layout: "split" }, async (state) => {
        const target = resolveInstallationTarget();
        vi.spyOn(fs, "writeFile").mockRejectedValue(
          Object.assign(new Error("EACCES: support artifact permission denied"), {
            code: "EACCES",
          }),
        );
        const runtime = createTriageRuntime();

        await expect(
          withTriageTerminal(terminal, () =>
            triageCommand(runtime, {
              json,
              nonInteractive,
              noExport: true,
              recovery: {
                target,
                updateFailure: { result: failedUpdate(state.statePath("install")) },
              },
            }),
          ),
        ).rejects.toMatchObject({ code: "EACCES" });

        expect(runtime.writeJson).not.toHaveBeenCalled();
        expect(mocks.spawn).not.toHaveBeenCalled();
      });
    },
  );
});

describe("standalone triage update evidence", () => {
  it.each([
    { status: "error" as const, reason: "background-doctor-failure" },
    { status: "skipped" as const, reason: "dirty" },
  ])(
    "reads a failed $status sentinel without consuming it or exposing routing instructions",
    async ({ status, reason }) => {
      await withOpenClawTestState({ layout: "split" }, async (state) => {
        const saved = await writeRestartSentinel({
          kind: "update",
          status,
          ts: 1,
          sessionKey: "private-session-route",
          message: "private-operator-note",
          continuation: { kind: "agentTurn", message: "untrusted-continuation-instruction" },
          stats: {
            mode: "npm",
            root: state.statePath("install"),
            reason,
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
        expect(prompt).toContain(reason);
        expect(prompt).toContain("2026.8.26");
        const evidence = JSON.parse(/```json\n([\s\S]+?)\n```/u.exec(prompt)?.[1] ?? "");
        expect(evidence.result.recovery).toBeUndefined();
        expect(prompt).toContain(
          "EACCES: cannot open $OPENCLAW_STATE_DIR/install/runtime-entry.js",
        );
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
    },
  );

  it("prefers the current updater failure over an older pending notification", async () => {
    await withOpenClawTestState({ layout: "split" }, async (state) => {
      await writeRestartSentinel({
        kind: "update",
        status: "error",
        ts: 1,
        stats: { reason: "older-pending-failure" },
      });
      const runtime = createTriageRuntime();
      await triageCommand(runtime, {
        json: true,
        noExport: true,
        recovery: {
          target: resolveInstallationTarget(),
          updateFailure: { result: failedUpdate(state.statePath("install")) },
        },
      });
      const prompt = await fs.readFile(runtime.writeJson.mock.calls[0]?.[0]?.promptPath, "utf8");
      expect(prompt).toContain("injected-doctor-failure");
      expect(prompt).not.toContain("older-pending-failure");
    });
  });

  it("preserves maintenance when an ancestor run does not actually hold its exclusion", async () => {
    await withOpenClawTestState({ layout: "split" }, async (state) => {
      const run = createUpdateRun({ trigger: "cli", origin: { driver: readUpdateRunDriver() } });
      const updateFailure = failedUpdate(state.statePath("install"));
      updateFailure.runId = run.runId;
      const runtime = createTriageRuntime();
      await triageCommand(runtime, {
        json: true,
        noExport: true,
        recovery: { target: resolveInstallationTarget(), updateFailure: { result: updateFailure } },
      });
      const prompt = await fs.readFile(runtime.writeJson.mock.calls[0]?.[0]?.promptPath, "utf8");
      expect(prompt).not.toContain(`Active update driver PID ${process.pid}`);
      expect(prompt).toContain("including `openclaw doctor --fix`");
    });
  });

  it("does not recommend excluded Doctor maintenance beneath the active update driver", async () => {
    await withOpenClawTestState({ layout: "split" }, async (state) => {
      const run = createUpdateRun({ trigger: "cli", origin: { driver: readUpdateRunDriver() } });
      const updateFailure = failedUpdate(state.statePath("install"));
      updateFailure.runId = run.runId;
      const coordinator = acquireGatewayLifecycleCoordinator({
        databasePath: resolveOpenClawStateSqlitePath(process.env),
      });
      const coordinatorPath = coordinator.path;
      coordinator.release();
      const holder = tryAcquireExclusiveSqliteCoordinator(coordinatorPath, { busyTimeoutMs: 0 });
      if (!holder) {
        throw new Error("Test lifecycle holder could not be acquired");
      }
      try {
        const runtime = createTriageRuntime();
        await triageCommand(runtime, {
          json: true,
          noExport: true,
          recovery: {
            target: resolveInstallationTarget(),
            updateFailure: { result: updateFailure },
          },
        });
        const prompt = await fs.readFile(runtime.writeJson.mock.calls[0]?.[0]?.promptPath, "utf8");
        expect(prompt).toContain(`Active update driver PID ${process.pid}`);
        expect(prompt).toContain("Do not run `openclaw doctor --fix`");
        expect(prompt).toContain("may continue only the matching inherited update run");
        expect(prompt).not.toContain("including `openclaw doctor --fix`");
      } finally {
        holder.release();
      }
    });
  });

  it("retains Doctor repair guidance when the running Gateway owns lifecycle contention", async () => {
    await withOpenClawTestState({ layout: "split" }, async (state) => {
      const run = createUpdateRun({ trigger: "cli", origin: { driver: readUpdateRunDriver() } });
      const updateFailure = failedUpdate(state.statePath("install"));
      updateFailure.runId = run.runId;
      mocks.readActiveGatewayLockIdentity.mockResolvedValue({
        pid: process.pid + 1,
        port: 18789,
        createdAt: new Date().toISOString(),
      });
      const coordinator = acquireGatewayLifecycleCoordinator({
        databasePath: resolveOpenClawStateSqlitePath(process.env),
      });
      const coordinatorPath = coordinator.path;
      coordinator.release();
      const holder = tryAcquireExclusiveSqliteCoordinator(coordinatorPath, { busyTimeoutMs: 0 });
      if (!holder) {
        throw new Error("Test Gateway lifecycle holder could not be acquired");
      }
      try {
        const runtime = createTriageRuntime();
        await triageCommand(runtime, {
          json: true,
          noExport: true,
          recovery: {
            target: resolveInstallationTarget(),
            updateFailure: { result: updateFailure },
          },
        });
        const prompt = await fs.readFile(runtime.writeJson.mock.calls[0]?.[0]?.promptPath, "utf8");
        expect(mocks.readActiveGatewayLockIdentity).toHaveBeenCalledOnce();
        expect(prompt).not.toContain(`Active update driver PID ${process.pid}`);
        expect(prompt).toContain("including `openclaw doctor --fix`");
      } finally {
        holder.release();
      }
    });
  });

  it.each([
    { status: "ok" as const, reason: "completed-update" },
    { status: "skipped" as const, reason: "already-current" },
    { status: "skipped" as const, reason: "managed-service-handoff-started" },
  ])(
    "does not project a $status/$reason notification as a failed update",
    async ({ status, reason }) => {
      await withOpenClawTestState({ layout: "split" }, async () => {
        await writeRestartSentinel({
          kind: "update",
          status,
          ts: 1,
          stats: { reason },
        });
        const runtime = createTriageRuntime();
        await triageCommand(runtime, { json: true, noExport: true });
        const prompt = await fs.readFile(runtime.writeJson.mock.calls[0]?.[0]?.promptPath, "utf8");
        expect(prompt).not.toContain(reason);
      });
    },
  );

  it("keeps an absent update outcome unknown without creating a state database", async () => {
    await withOpenClawTestState({ layout: "split" }, async (state) => {
      const databasePath = path.join(state.stateDir, "state", "openclaw.sqlite");
      await expect(fs.access(databasePath)).rejects.toMatchObject({ code: "ENOENT" });
      await triageCommand(createTriageRuntime(), { json: true, noExport: true });
      await expect(fs.access(databasePath)).rejects.toMatchObject({ code: "ENOENT" });
    });
  });
});
