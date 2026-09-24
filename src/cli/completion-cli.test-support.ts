import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { createInterface, type Interface as ReadlineInterface } from "node:readline";
import { Command } from "commander";
import { expect, it, type TestAPI } from "vitest";
import { getCompletionScript, registerCompletionCli } from "./completion-cli.js";
import { quoteCliArg } from "./quote-cli-arg.js";

export function createCompletionProgram(): Command {
  const program = new Command();
  program.name("openclaw");
  program.description("CLI root");
  program.option("-v, --verbose", "Verbose output");
  program.option(
    "--status-json",
    "Output JSON (alias for `models status --json`) in $OPENCLAW_STATE_DIR",
  );

  const gateway = program.command("gateway").description("Gateway commands");
  gateway.option("--force", "Force the action");
  gateway.option("-t, --token <token>", "Gateway token");

  gateway.command("status").description("Show gateway status").option("--json", "JSON output");
  gateway.command("restart").description("Restart gateway");
  program
    .command("agent")
    .description("Agent commands")
    .option("--verbose <on|off>", "Set verbosity");
  const sessions = program.command("sessions").description("Session commands");
  sessions.option("--verbose", "Verbose output");
  sessions.command("cleanup").description("Clean sessions").option("--dry-run", "Preview cleanup");

  return program;
}

export function createDocumentedCompletionProgram(): Command {
  const program = createCompletionProgram();
  registerCompletionCli(program);
  return program;
}

export function createAliasedCompletionProgram(): Command {
  const program = new Command();
  program.name("openclaw");
  program.option("--profile <name>", "Profile");
  const infer = program.command("infer").alias("capability").description("Run inference");
  infer.command("embed").description("Embed text").option("--model <id>", "Model id");
  const cron = program.command("cron").description("Cron commands");
  cron
    .command("add")
    .alias("create")
    .description("Add a job")
    .option("--at <time>", "Schedule time");
  return program;
}

type BashCompletionInput = {
  line?: string;
  word?: string;
  point?: number;
  cword?: number;
  bashPath?: string;
  env?: NodeJS.ProcessEnv;
};

export function runGeneratedBashCompletion(
  program: Command,
  words: readonly string[],
  input: BashCompletionInput = {},
): string[] {
  const script = getCompletionScript("bash", program);
  return runBashCompletionScript(script, words, input);
}

export function runBashCompletionScript(
  script: string,
  words: readonly string[],
  input: BashCompletionInput = {},
): string[] {
  const result = spawnSync(input.bashPath ?? "bash", ["--noprofile", "--norc"], {
    encoding: "utf8",
    env: input.env,
    input: `${script}
COMP_WORDS=(${words.map(quoteCliArg).join(" ")})
COMP_CWORD=${input.cword ?? words.length - 1}
COMP_LINE=${quoteCliArg(input.line ?? words.join(" "))}
COMP_POINT=${input.point ?? "${#COMP_LINE}"}
_openclaw_completion openclaw ${quoteCliArg(input.word ?? words.at(-1) ?? "")}
printf '%s\\n' "\${COMPREPLY[@]}"
`,
  });

  if (result.error) {
    throw result.error;
  }
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
  return result.stdout.split("\n").filter(Boolean);
}

function findFish(): string | null {
  const executable = process.platform === "win32" ? "fish.exe" : "fish";
  const candidates = (process.env.PATH ?? "")
    .split(path.delimiter)
    .filter(Boolean)
    .map((directory) => path.join(directory, executable));
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

const fishPath = findFish();
export const itWithFish: TestAPI["skip"] = fishPath ? it : it.skip;

export function runGeneratedFishCompletion(program: Command, commandLine: string): string[] {
  return runFishCompletionScript(getCompletionScript("fish", program), commandLine);
}

export function runFishCompletionScript(script: string, commandLine: string): string[] {
  if (!fishPath) {
    throw new Error("Fish is unavailable");
  }

  const quotedCommandLine = commandLine.replaceAll("'", "\\'");
  const result = spawnSync(fishPath, ["--no-config"], {
    encoding: "utf8",
    timeout: 15_000,
    input: `${script}\ncomplete --do-complete '${quotedCommandLine}'\n`,
  });

  if (result.error) {
    throw result.error;
  }
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
  return result.stdout
    .split(/\r?\n/)
    .filter(Boolean)
    .map((completion) => completion.split("\t")[0] ?? completion);
}

function findPowerShell(): string | null {
  const executable = process.platform === "win32" ? "pwsh.exe" : "pwsh";
  const candidates = [
    process.env.OPENCLAW_TEST_PWSH,
    ...(process.env.PATH ?? "")
      .split(path.delimiter)
      .filter(Boolean)
      .map((directory) => path.join(directory, executable)),
  ];
  return (
    candidates.find((candidate): candidate is string =>
      Boolean(candidate && existsSync(candidate)),
    ) ?? null
  );
}

const powerShellPath = findPowerShell();
export const itWithPowerShell: TestAPI["skip"] = powerShellPath ? it : it.skip;

type PowerShellCompletionResponse =
  | { version: 1; id: string; ok: true; completions: string[] }
  | { version: 1; id: string; ok: false; error: string };

type PendingPowerShellCompletion = {
  reject: (error: Error) => void;
  resolve: (completions: string[]) => void;
  timeout: ReturnType<typeof setTimeout>;
};

const POWERSHELL_CASE_TIMEOUT_MS = 15_000;
const POWERSHELL_CLOSE_TIMEOUT_MS = 5_000;

function encodePowerShellHostScript(framePrefix: string): string {
  const script = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::Out.WriteLine('${framePrefix}READY')
[Console]::Out.Flush()
while (($encodedRequest = [Console]::In.ReadLine()) -ne $null) {
  $request = $null
  try {
    $requestJson = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($encodedRequest))
    $request = $requestJson | ConvertFrom-Json
    $completionScript = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([string]$request.script))
    $commandLine = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([string]$request.commandLine))
    Register-ArgumentCompleter -Native -CommandName openclaw -ScriptBlock $null
    Invoke-Expression $completionScript | Out-Null
    $completions = @(
      [System.Management.Automation.CommandCompletion]::CompleteInput(
        $commandLine,
        [int]$request.cursorPosition,
        $null
      ).CompletionMatches | ForEach-Object { [string]$_.CompletionText }
    )
    $response = @{ version = 1; id = [string]$request.id; ok = $true; completions = $completions }
  } catch {
    $responseId = if ($null -ne $request -and $null -ne $request.id) {
      [string]$request.id
    } else {
      'unknown'
    }
    $response = @{ version = 1; id = $responseId; ok = $false; error = ($_ | Out-String).Trim() }
  } finally {
    Register-ArgumentCompleter -Native -CommandName openclaw -ScriptBlock $null
  }
  $responseJson = $response | ConvertTo-Json -Compress -Depth 5
  $encodedResponse = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($responseJson))
  [Console]::Out.WriteLine('${framePrefix}' + $encodedResponse)
  [Console]::Out.Flush()
}
`;
  return Buffer.from(script, "utf16le").toString("base64");
}

function decodePowerShellCompletionResponse(encoded: string): PowerShellCompletionResponse {
  const value = JSON.parse(Buffer.from(encoded, "base64").toString("utf8")) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("PowerShell completion response was not an object");
  }
  const response = value as Record<string, unknown>;
  if (
    response.version !== 1 ||
    typeof response.id !== "string" ||
    typeof response.ok !== "boolean"
  ) {
    throw new Error("PowerShell completion response had an invalid envelope");
  }
  if (response.ok) {
    if (
      !Array.isArray(response.completions) ||
      !response.completions.every((completion) => typeof completion === "string")
    ) {
      throw new Error("PowerShell completion response had invalid completions");
    }
    return {
      version: 1,
      id: response.id,
      ok: true,
      completions: response.completions,
    };
  }
  if (typeof response.error !== "string") {
    throw new Error("PowerShell completion response had no error text");
  }
  return { version: 1, id: response.id, ok: false, error: response.error };
}

/** One live PowerShell process per test file; cases remain sequential and state-isolated. */
export class PowerShellCompletionRunner {
  private child: ChildProcessWithoutNullStreams | undefined;
  private closing = false;
  private exitPromise: Promise<{ code: number | null; signal: NodeJS.Signals | null }> | undefined;
  private failure: Error | undefined;
  private readonly framePrefix = `OPENCLAW_PWSH_V1:${randomBytes(8).toString("hex")}:`;
  private pending = new Map<string, PendingPowerShellCompletion>();
  private queue: Promise<void> = Promise.resolve();
  private readyPromise: Promise<void> | undefined;
  private stdoutLines: ReadlineInterface | undefined;

  complete(
    program: Command,
    commandLine: string,
    cursorPosition = commandLine.length,
  ): Promise<string[]> {
    return this.completeScript(
      getCompletionScript("powershell", program),
      commandLine,
      cursorPosition,
    );
  }

  completeScript(
    script: string,
    commandLine: string,
    cursorPosition = commandLine.length,
  ): Promise<string[]> {
    const caseId = createHash("sha256")
      .update(script)
      .update("\0")
      .update(commandLine)
      .update("\0")
      .update(String(cursorPosition))
      .digest("hex")
      .slice(0, 20);
    const result = this.queue.then(() =>
      this.completeCase(caseId, script, commandLine, cursorPosition),
    );
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async close(): Promise<void> {
    await this.queue;
    if (!this.child || !this.exitPromise) {
      return;
    }
    this.closing = true;
    this.child.stdin.end();
    let closeTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      const outcome = await Promise.race([
        this.exitPromise,
        new Promise<never>((_resolve, reject) => {
          closeTimer = setTimeout(
            () => reject(new Error("PowerShell completion runner did not exit after stdin closed")),
            POWERSHELL_CLOSE_TIMEOUT_MS,
          );
        }),
      ]);
      // Cleanup must preserve the failure that already rejected queued completions.
      if (this.failure) {
        throw this.failure;
      }
      if (outcome.code !== 0 || outcome.signal !== null) {
        throw new Error(
          `PowerShell completion runner exited with code ${String(outcome.code)} signal ${String(outcome.signal)}`,
        );
      }
    } catch (error) {
      this.child.kill("SIGTERM");
      setTimeout(() => this.child?.kill("SIGKILL"), 1_000).unref();
      throw this.failure ?? error;
    } finally {
      if (closeTimer) {
        clearTimeout(closeTimer);
      }
      this.stdoutLines?.close();
    }
  }

  private async completeCase(
    caseId: string,
    script: string,
    commandLine: string,
    cursorPosition: number,
  ): Promise<string[]> {
    await this.start();
    if (this.failure) {
      throw this.failure;
    }
    const child = this.child;
    if (!child) {
      throw new Error("PowerShell completion runner did not start");
    }
    const request = Buffer.from(
      JSON.stringify({
        version: 1,
        id: caseId,
        script: Buffer.from(script, "utf8").toString("base64"),
        commandLine: Buffer.from(commandLine, "utf8").toString("base64"),
        cursorPosition,
      }),
      "utf8",
    ).toString("base64");
    return await new Promise<string[]>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.poison(new Error(`PowerShell completion case ${caseId} timed out`));
      }, POWERSHELL_CASE_TIMEOUT_MS);
      this.pending.set(caseId, { reject, resolve, timeout });
      child.stdin.write(`${request}\n`, (error) => {
        if (error) {
          this.poison(new Error(`PowerShell completion write failed: ${error.message}`));
        }
      });
    });
  }

  private start(): Promise<void> {
    if (this.readyPromise) {
      return this.readyPromise;
    }
    if (!powerShellPath) {
      return Promise.reject(new Error("PowerShell is unavailable"));
    }
    const child = spawn(
      powerShellPath,
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        encodePowerShellHostScript(this.framePrefix),
      ],
      { stdio: "pipe" },
    );
    this.child = child;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    this.stdoutLines = createInterface({ input: child.stdout });
    this.readyPromise = new Promise<void>((resolve, reject) => {
      const readyTimeout = setTimeout(
        () => fail(new Error("PowerShell completion runner did not become ready")),
        POWERSHELL_CASE_TIMEOUT_MS,
      );
      // Before READY there are no pending requests; poisoning alone would strand the queue.
      const fail = (error: Error) => {
        clearTimeout(readyTimeout);
        reject(error);
        this.poison(error);
      };
      this.stdoutLines?.on("line", (line) => {
        if (line === `${this.framePrefix}READY`) {
          clearTimeout(readyTimeout);
          resolve();
          return;
        }
        if (!line.startsWith(this.framePrefix)) {
          fail(new Error(`Unexpected PowerShell completion stdout: ${line}`));
          return;
        }
        try {
          const response = decodePowerShellCompletionResponse(line.slice(this.framePrefix.length));
          const pending = this.pending.get(response.id);
          if (!pending) {
            fail(new Error(`Unexpected PowerShell completion response id: ${response.id}`));
            return;
          }
          clearTimeout(pending.timeout);
          this.pending.delete(response.id);
          if (response.ok) {
            pending.resolve(response.completions);
          } else {
            pending.reject(
              new Error(`PowerShell completion case ${response.id} failed: ${response.error}`),
            );
          }
        } catch (error) {
          fail(error instanceof Error ? error : new Error(String(error)));
        }
      });
      child.once("error", fail);
      child.stderr.on("data", (chunk: string) => {
        const stderr = chunk.trim();
        if (stderr) {
          fail(new Error(`Unexpected PowerShell completion stderr: ${stderr}`));
        }
      });
      this.exitPromise = new Promise((exitResolve) => {
        child.once("exit", (code, signal) => {
          exitResolve({ code, signal });
          if (!this.closing || code !== 0 || signal !== null) {
            fail(
              new Error(
                `PowerShell completion runner exited unexpectedly with code ${String(code)} signal ${String(signal)}`,
              ),
            );
          }
        });
      });
    });
    return this.readyPromise;
  }

  private poison(error: Error): void {
    if (this.failure) {
      return;
    }
    this.failure = error;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
    if (!this.closing) {
      this.child?.kill("SIGTERM");
    }
  }
}
