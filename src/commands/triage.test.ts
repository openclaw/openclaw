import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";
import JSZip from "jszip";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { UpdateCommandFailure } from "../cli/update-cli/update-command-result.js";
import { withUpdateFailureTriage } from "../cli/update-cli/update-command-triage.js";
import type { HealthFinding } from "../flows/health-checks.js";
import { resolveInstallationTarget } from "../infra/installation-target-context.js";
import type { UpdateRunResult } from "../infra/update-runner-types.js";
import { defaultRuntime } from "../runtime.js";
import { createDeferredCore } from "../shared/deferred.js";
import { triageCommand } from "./triage.js";
import {
  createTriageRuntime,
  resetTriageRepairRuntimeMocks,
  withTriageTerminal,
} from "./triage.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const failedUpdate: UpdateRunResult = {
  status: "error",
  mode: "npm",
  reason: "install failed",
  steps: [],
  durationMs: 1,
};

const mocks = vi.hoisted(() => ({
  confirm: vi.fn(),
  select: vi.fn(),
  collectDoctorFindings: vi.fn(),
  callGatewayFromCliWithTransport: vi.fn(),
  writeDiagnosticSupportExport: vi.fn(),
  gatherDaemonStatus: vi.fn(),
  runUpdateRepairLoop: vi.fn(),
  prepareUpdateRepairInference: vi.fn(),
  runUpdateRepairTurn: vi.fn(),
  resolveExecutablePath: vi.fn(),
  runUtf8CommandWithTimeout: vi.fn(),
  spawn: vi.fn(),
}));

vi.mock("@clack/prompts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@clack/prompts")>()),
  confirm: mocks.confirm,
  select: mocks.select,
}));

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: mocks.spawn,
}));

vi.mock("./doctor-lint-runner.js", () => ({
  collectDoctorFindings: mocks.collectDoctorFindings,
}));

vi.mock("../infra/executable-path.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/executable-path.js")>()),
  resolveExecutablePath: mocks.resolveExecutablePath,
}));

vi.mock("../process/exec.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../process/exec.js")>()),
  runUtf8CommandWithTimeout: mocks.runUtf8CommandWithTimeout,
}));

vi.mock("../cli/gateway-rpc.js", () => ({
  callGatewayFromCliWithTransport: mocks.callGatewayFromCliWithTransport,
}));

vi.mock("../logging/diagnostic-support-export.js", () => ({
  writeDiagnosticSupportExport: mocks.writeDiagnosticSupportExport,
}));

vi.mock("../cli/daemon-cli/status.gather.js", () => ({
  gatherDaemonStatus: mocks.gatherDaemonStatus,
}));

vi.mock("../infra/update-repair-agent.js", () => ({
  runUpdateRepairLoop: mocks.runUpdateRepairLoop,
}));

vi.mock("../infra/update-repair-agent.runtime.js", () => ({
  prepareUpdateRepairInference: mocks.prepareUpdateRepairInference,
  runUpdateRepairTurn: mocks.runUpdateRepairTurn,
}));

describe("triageCommand", () => {
  let stateDir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.confirm.mockResolvedValue(true);
    mocks.select.mockResolvedValue("triage");
    stateDir = tempDirs.make("openclaw-triage-test-");
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    vi.stubEnv("OPENCLAW_SHELL", "");
    vi.stubEnv("OPENCLAW_SUPERVISOR_MODE", "");
    vi.stubEnv("CODEX_THREAD_ID", "");
    vi.stubEnv("OPENCLAW_CONFIG_PATH", undefined);
    vi.stubEnv("OPENCLAW_WORKSPACE_DIR", undefined);
    mocks.collectDoctorFindings.mockResolvedValue([]);
    resetTriageRepairRuntimeMocks(mocks, stateDir);
    mocks.resolveExecutablePath.mockReturnValue(undefined);
    mocks.runUtf8CommandWithTimeout.mockImplementation(async (argv, options) => {
      if (argv.at(-1) === "--help") {
        return { stdout: "--safe-mode", stderr: "", code: 0, termination: "exit" };
      }
      const actual =
        await vi.importActual<typeof import("../process/exec.js")>("../process/exec.js");
      return await actual.runUtf8CommandWithTimeout(argv, options);
    });
    mocks.spawn.mockImplementation(() => {
      const child = new EventEmitter();
      queueMicrotask(() => child.emit("exit", 0, null));
      return child;
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("keeps the updater's failure exit code when automatic triage is declined", async () => {
    mocks.confirm.mockResolvedValue(false);
    mocks.resolveExecutablePath.mockImplementation((agent: string) =>
      agent === "claude" ? "/usr/local/bin/claude" : undefined,
    );
    const log = vi.spyOn(defaultRuntime, "log").mockImplementation(() => {});
    const failure = new UpdateCommandFailure(failedUpdate, 17);
    await withTriageTerminal(true, async () => {
      await expect(
        withUpdateFailureTriage({}, { env: { ...process.env } }, async () => {
          throw failure;
        }),
      ).rejects.toMatchObject({ code: 17 });
    });
    expect(mocks.confirm).toHaveBeenCalledOnce();
    expect(mocks.spawn).not.toHaveBeenCalled();
    expect(mocks.runUpdateRepairLoop).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith("No repair agent was started.");
  });

  it.each([
    { answer: "y", run: false, launches: true },
    { answer: "y", run: true, launches: true },
    { answer: "\r", run: false, launches: false },
    { answer: "timeout", run: false, launches: false },
    { answer: "\u0003", run: false, launches: false },
    { answer: "abort", run: false, launches: false },
    { answer: "owner-loss", run: false, launches: false },
  ])(
    "settles the real update prompt for $answer (embedded=$run)",
    async ({ answer, run, launches }) => {
      const clack = await vi.importActual<typeof import("@clack/prompts")>("@clack/prompts");
      const input = new PassThrough();
      const output = new PassThrough();
      const started = createDeferredCore();
      const controller = new AbortController();
      let current = true;
      mocks.confirm.mockImplementation((options: Parameters<typeof clack.confirm>[0]) => {
        const pending = clack.confirm({ ...options, input, output });
        started.resolve();
        return pending;
      });
      mocks.resolveExecutablePath.mockImplementation((agent: string) =>
        agent === "claude" ? "/usr/local/bin/claude" : undefined,
      );
      const runtime = createTriageRuntime();
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        await withTriageTerminal(true, async () => {
          const pending = triageCommand(runtime, {
            run,
            recovery: {
              target: resolveInstallationTarget(),
              updateFailure: { error: "install failed" },
              signal: controller.signal,
              isCurrent: () => current && !controller.signal.aborted,
            },
          });
          await started.promise;
          expect(mocks.spawn).not.toHaveBeenCalled();
          expect(mocks.runUpdateRepairLoop).not.toHaveBeenCalled();
          const agent = run ? "the embedded OpenClaw agent using your configured model" : "claude";
          expect(runtime.log).toHaveBeenCalledWith(
            `Agent: ${agent}. This will use your own account/tokens.`,
          );
          expect(mocks.confirm.mock.calls[0]?.[0].message).toContain(
            `Open ${agent} to diagnose and repair the installation now? [y/N]`,
          );
          if (answer === "timeout") {
            await vi.advanceTimersByTimeAsync(29_999);
            expect(mocks.spawn).not.toHaveBeenCalled();
            expect(mocks.runUpdateRepairLoop).not.toHaveBeenCalled();
            await vi.advanceTimersByTimeAsync(1);
          } else if (answer === "abort") {
            controller.abort();
          } else {
            if (answer === "owner-loss") {
              current = false;
            }
            input.write(answer === "owner-loss" ? "y" : answer);
          }
          await pending;
          expect(mocks.spawn).toHaveBeenCalledTimes(launches && !run ? 1 : 0);
          expect(mocks.runUpdateRepairLoop).toHaveBeenCalledTimes(launches && run ? 1 : 0);
          expect(
            runtime.log.mock.calls
              .flat()
              .join("\n")
              .includes("No answer; skipping automatic repair."),
          ).toBe(answer === "timeout");
          expect(input.listenerCount("keypress")).toBe(0);
          expect(output.listenerCount("resize")).toBe(0);
          expect(input.isPaused()).toBe(true);
          expect(vi.getTimerCount()).toBe(0);
        });
      } finally {
        controller.abort();
        input.destroy();
        output.destroy();
      }
    },
  );

  it("writes one stable JSON handoff without probing inference or starting an agent", async () => {
    const findings: HealthFinding[] = [
      { checkId: "core/error", severity: "error", message: "broken" },
      { checkId: "core/warning", severity: "warning", message: "warn" },
      { checkId: "core/info", severity: "info", message: "detail" },
    ];
    mocks.collectDoctorFindings.mockResolvedValue(findings);
    const runtime = createTriageRuntime();

    await triageCommand(runtime, { json: true, noExport: true });

    const promptPath = runtime.writeJson.mock.calls[0]?.[0]?.promptPath as string;
    const targetEnv = `env OPENCLAW_STATE_DIR='${stateDir}' OPENCLAW_CONFIG_PATH='${path.join(stateDir, "openclaw.json")}' OPENCLAW_WORKSPACE_DIR='${path.join(stateDir, "workspace")}'`;
    expect(runtime.writeJson).toHaveBeenCalledOnce();
    expect(path.isAbsolute(promptPath)).toBe(true);
    expect(promptPath.startsWith(stateDir)).toBe(true);
    expect(runtime.writeJson.mock.calls[0]?.[0]).toEqual({
      promptPath,
      bundlePath: null,
      bundleError: null,
      findings: { error: 1, warning: 1, info: 1 },
      detectedAgents: [],
      suggestedCommands:
        process.platform === "win32"
          ? [
              expect.stringContaining("| & codex exec --skip-git-repo-check -"),
              expect.stringContaining("| & claude -p"),
              expect.stringContaining("| & pi --print"),
              expect.stringContaining("| & opencode run"),
              expect.stringContaining("& muse exec --prompt-file"),
              expect.stringContaining("& grok --prompt-file"),
              expect.stringContaining("| & cursor-agent --print"),
              expect.stringContaining("& kimi --prompt"),
              expect.stringContaining("| & qwen"),
              expect.stringContaining("& agy --prompt-interactive"),
              expect.stringContaining("& openclaw triage --run"),
            ]
          : [
              `${targetEnv} codex exec --skip-git-repo-check - < '${promptPath}'`,
              `${targetEnv} claude -p < '${promptPath}'`,
              `${targetEnv} pi --print < '${promptPath}'`,
              `${targetEnv} opencode run < '${promptPath}'`,
              `${targetEnv} muse exec --prompt-file ${promptPath}`,
              `${targetEnv} grok --prompt-file ${promptPath}`,
              `${targetEnv} cursor-agent --print < '${promptPath}'`,
              `${targetEnv} kimi --prompt 'Read the debugging prompt at ${promptPath} and follow its repair and verification instructions.'`,
              `${targetEnv} qwen < '${promptPath}'`,
              `${targetEnv} agy --prompt-interactive 'Read the debugging prompt at ${promptPath} and follow its repair and verification instructions.'`,
              `${targetEnv} openclaw triage --run`,
            ],
    });
    expect(await fs.readFile(promptPath, "utf8")).toContain("[error] core/error: broken");
    expect(mocks.callGatewayFromCliWithTransport).not.toHaveBeenCalled();
    expect(mocks.runUpdateRepairLoop).not.toHaveBeenCalled();
  });

  it.each([true])("preserves manual non-TTY semantics (run=%s)", async (run) => {
    await withTriageTerminal(false, async () => {
      const invocation = triageCommand(createTriageRuntime(), { noExport: true, run });
      if (run) {
        await expect(invocation).rejects.toThrow("requires an interactive terminal");
      } else {
        await invocation;
      }
    });
    expect(mocks.runUpdateRepairLoop).not.toHaveBeenCalled();
    expect(mocks.runUpdateRepairTurn).not.toHaveBeenCalled();
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it("preserves a failed update when Doctor and export fail in piped mode", async () => {
    const secret = "sk-test-update-triage-secret-1234567890";
    mocks.collectDoctorFindings.mockRejectedValue(new Error(`Doctor unavailable token=${secret}`));
    mocks.writeDiagnosticSupportExport.mockRejectedValue(
      new Error(`Export unavailable token=${secret}`),
    );
    const runtime = createTriageRuntime();
    const updateResult = path.join(stateDir, "failed-update.json");
    await fs.writeFile(
      updateResult,
      JSON.stringify({ error: `Original update failed at ${stateDir}; token=${secret}` }),
    );

    await withTriageTerminal(false, async () => {
      await triageCommand(runtime, {
        updateResult,
      });
    });

    const promptPath = String(runtime.log.mock.calls[0]?.[0]).replace("Debugging prompt: ", "");
    const prompt = await fs.readFile(promptPath, "utf8");
    expect(prompt).toContain("Original update failed at $OPENCLAW_STATE_DIR");
    expect(prompt).toContain("Doctor checks unavailable:");
    expect(prompt).toContain("Diagnostics export unavailable:");
    expect(prompt).not.toContain(secret);
    expect(prompt).not.toContain(stateDir);
    const output = runtime.log.mock.calls;
    expect(JSON.stringify(output)).toContain("--update-result");
    expect(JSON.stringify(output)).not.toContain(secret);
    expect(mocks.spawn).not.toHaveBeenCalled();
    expect(mocks.runUpdateRepairLoop).not.toHaveBeenCalled();
    expect(mocks.confirm).not.toHaveBeenCalled();
  });

  it("preserves local diagnostics and redacted snapshot failures while the Gateway is offline", async () => {
    const { writeDiagnosticSupportExport } = await vi.importActual<
      typeof import("../logging/diagnostic-support-export.js")
    >("../logging/diagnostic-support-export.js");
    const secret = "sk-test-triage-offline-secret-1234567890";
    const configPath = path.join(stateDir, "openclaw.json");
    await fs.writeFile(configPath, JSON.stringify({ gateway: { auth: { token: secret } } }));
    mocks.callGatewayFromCliWithTransport.mockRejectedValue(new Error(`Offline token=${secret}`));
    mocks.gatherDaemonStatus.mockRejectedValue(new Error("Status unavailable"));
    mocks.writeDiagnosticSupportExport.mockImplementation((options) =>
      writeDiagnosticSupportExport({
        ...options,
        stateDir,
        env: { HOME: stateDir, OPENCLAW_CONFIG_PATH: configPath },
        readLogTail: async () => ({
          file: path.join(stateDir, "gateway.log"),
          cursor: 0,
          size: 0,
          lines: [],
          truncated: false,
          reset: false,
        }),
      }),
    );
    const runtime = createTriageRuntime();

    await triageCommand(runtime, { json: true });

    const report = runtime.writeJson.mock.calls[0]?.[0] as {
      promptPath: string;
      bundlePath: string;
      bundleError: string | null;
    };
    expect(report.bundleError).toBeNull();
    expect(report.bundlePath).toEqual(expect.any(String));
    const zip = await JSZip.loadAsync(await fs.readFile(report.bundlePath));
    const diagnostics = JSON.parse(await zip.file("diagnostics.json")!.async("string"));
    expect(diagnostics.config).toMatchObject({ exists: true, parseOk: true });
    expect(diagnostics.health).toMatchObject({ status: "failed" });
    expect(diagnostics.status).toMatchObject({ status: "failed" });
    const entries = await Promise.all(
      Object.values(zip.files)
        .filter((entry) => !entry.dir)
        .map((entry) => entry.async("string")),
    );
    expect(entries.join("\n")).not.toContain(secret);
    expect(entries.join("\n")).not.toContain(stateDir);
    expect(await fs.readFile(report.promptPath, "utf8")).toContain("Sanitized ZIP:");
    if (process.platform !== "win32") {
      for (const file of [report.promptPath, report.bundlePath]) {
        expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
      }
      expect((await fs.stat(path.dirname(report.promptPath))).mode & 0o777).toBe(0o700);
    }
  });

  it.each([false, true])(
    "does not start a closed recovery after writing its prompt (embedded=%s)",
    async (run) => {
      mocks.resolveExecutablePath.mockImplementation((agent: string) =>
        agent === "claude" ? "/usr/local/bin/claude" : undefined,
      );
      let current = true;
      const writeFile = fs.writeFile.bind(fs);
      vi.spyOn(fs, "writeFile").mockImplementation(async (...args) => {
        await writeFile(...args);
        if (typeof args[0] === "string" && args[0].includes("openclaw-triage-prompt-")) {
          current = false;
        }
      });
      const runtime = createTriageRuntime();
      await withTriageTerminal(true, () =>
        triageCommand(runtime, {
          run,
          recovery: {
            target: resolveInstallationTarget(),
            updateFailure: { error: "Captured update failure" },
            isCurrent: () => current,
          },
        }),
      );
      expect(current).toBe(false);
      expect(mocks.spawn).not.toHaveBeenCalled();
      expect(mocks.runUpdateRepairLoop).not.toHaveBeenCalled();
      expect(runtime.log).not.toHaveBeenCalled();
      expect(runtime.error).not.toHaveBeenCalled();
    },
  );

  it.each(["PATH"])(
    "launches a recognized Windows npm agent shim with a literal prompt using %s Node",
    async (nodeSource) => {
      const binDir = path.join(stateDir, "Windows npm bins");
      const entrypoint = path.join(binDir, "agent.cjs");
      const shimPath = path.join(binDir, "claude.cmd");
      const pathNode = path.join(binDir, "node.exe");
      const currentNode = path.join(binDir, "current", "node.exe");
      await fs.mkdir(binDir, { recursive: true });
      await fs.writeFile(entrypoint, "", "utf8");
      await fs.writeFile(pathNode, "", "utf8");
      await fs.writeFile(
        shimPath,
        [
          "@ECHO off",
          "GOTO start",
          ":find_dp0",
          "SET dp0=%~dp0",
          "EXIT /b",
          ":start",
          "SETLOCAL",
          "CALL :find_dp0",
          'IF EXIST "%dp0%\\node.exe" (SET "_prog=%dp0%\\node.exe") ELSE (SET "_prog=node")',
          'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%" "%dp0%\\agent.cjs" %*',
          "",
        ].join("\r\n"),
        "utf8",
      );
      const executablePaths = await vi.importActual<typeof import("../infra/executable-path.js")>(
        "../infra/executable-path.js",
      );
      mocks.resolveExecutablePath.mockImplementation(executablePaths.resolveExecutablePath);
      mocks.collectDoctorFindings.mockResolvedValue([
        { checkId: "core/repair", severity: "error", message: 'Repair A&B at 100%: ! "quoted"' },
      ]);
      vi.stubEnv("PATH", binDir);
      vi.stubEnv("PATHEXT", ".EXE;.CMD;.BAT");
      vi.spyOn(process, "platform", "get").mockReturnValue("win32");
      vi.spyOn(process, "execPath", "get").mockReturnValue(
        nodeSource === "current" ? currentNode : path.join(binDir, "openclaw.exe"),
      );
      const runtime = createTriageRuntime();

      await withTriageTerminal(true, () => triageCommand(runtime, { noExport: true }));

      expect(mocks.spawn).toHaveBeenCalledOnce();
      const [command, argv, options] = mocks.spawn.mock.calls[0] ?? [];
      const promptPath = String(runtime.log.mock.calls[0]?.[0]).replace("Debugging prompt: ", "");
      const prompt = await fs.readFile(promptPath, "utf8");
      expect(prompt).toContain('Repair A&B at 100%: ! "quoted"');
      expect(prompt).toContain("\n");
      expect(command).toBe(nodeSource === "current" ? currentNode : pathNode);
      expect(argv).toEqual([entrypoint, "--safe-mode", prompt]);
      expect(options?.stdio).toBe("inherit");
      expect(options?.shell).not.toBe(true);
      expect(options?.windowsHide).not.toBe(true);
      expect(options?.env.OPENCLAW_STATE_DIR).toBe(stateDir);
      expect(options?.env.OPENCLAW_CONFIG_PATH).toBe(path.join(stateDir, "openclaw.json"));
      expect(runtime.exit).not.toHaveBeenCalled();
    },
  );

  it.each([{ agent: "codex", executablePath: "C:\\tools\\codex.BAT" }])(
    "keeps unresolved Windows $agent wrappers as executable PowerShell manual handoffs",
    async ({ agent, executablePath }) => {
      const configPath = path.join(stateDir, "operator's $config`file.json");
      vi.stubEnv("OPENCLAW_CONFIG_PATH", configPath);
      vi.spyOn(process, "platform", "get").mockReturnValue("win32");
      mocks.resolveExecutablePath.mockImplementation((binary: string) =>
        binary === agent ? executablePath : undefined,
      );
      const runtime = createTriageRuntime();

      await withTriageTerminal(true, () => triageCommand(runtime, { noExport: true }));

      const commands = runtime.log.mock.calls
        .map(([line]) => String(line))
        .filter((line) => line.startsWith("  "));
      expect(commands).toHaveLength(1);
      expect(commands[0]).not.toMatch(/^ {2}env /u);
      expect(commands[0]).toContain(`'${configPath.replaceAll("'", "''")}'`);
      expect(commands[0]).toContain(
        agent === "claude" ? "| & claude -p" : "| & codex exec --skip-git-repo-check -",
      );
      expect(commands[0]).toContain("Get-Content -Raw -Encoding UTF8 -LiteralPath ");
      expect(mocks.spawn).not.toHaveBeenCalled();
    },
  );

  it("reports a failed launch without trying another installed agent", async () => {
    mocks.resolveExecutablePath.mockImplementation((binary: string) => `/usr/local/bin/${binary}`);
    mocks.spawn.mockImplementation(() => {
      const child = new EventEmitter();
      queueMicrotask(() => child.emit("error", new Error("permission denied")));
      return child;
    });
    const runtime = createTriageRuntime();

    await withTriageTerminal(true, async () => {
      await expect(triageCommand(runtime, { noExport: true })).rejects.toMatchObject({ code: 1 });
    });

    expect(mocks.spawn).toHaveBeenCalledOnce();
    expect(runtime.error).toHaveBeenCalledWith("Failed to launch codex: permission denied");
    expect(runtime.log).toHaveBeenCalledWith(
      expect.stringMatching(
        process.platform === "win32"
          ? /Run manually: .*\| & codex exec/u
          : /^Run manually: env .* codex exec/u,
      ),
    );
    expect(runtime.exit).toHaveBeenCalledExactlyOnceWith(1);
  });
});
