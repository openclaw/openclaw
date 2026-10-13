import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { createQaGatewayChild } from "../../../../extensions/qa-lab/api.js";
import { createQaScriptEvidenceWriter } from "./script-evidence.js";

const execFileAsync = promisify(execFile);
const SCENARIO_ID = "cli-status-health-snapshots";
const SOURCE_PATH = "test/e2e/qa-lab/runtime/cli-status-health-snapshots.ts";
const COMMAND_TIMEOUT_MS = 15_000;

type CliCommand = {
  argsPrefix: readonly string[];
  cwd: string;
  executablePath: string;
};

type CliResult = {
  exitCode: number;
  stderr: string;
  stdout: string;
};

type JsonRecord = Record<string, unknown>;

function artifactBase(argv: readonly string[]): string {
  const index = argv.indexOf("--artifact-base");
  const value = index >= 0 ? argv[index + 1] : undefined;
  if (!value) {
    throw new Error("--artifact-base is required");
  }
  return path.resolve(value);
}

function parseJsonRecord(label: string, text: string): JsonRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`${label} did not emit parseable JSON`, { cause: error });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${label} did not emit a JSON object`);
  }
  return parsed as JsonRecord;
}

function record(value: unknown): JsonRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : undefined;
}

function assertTokenAbsent(token: string, outputs: readonly string[]): void {
  for (const output of outputs) {
    if (output.includes(token)) {
      throw new Error("CLI status or health output exposed the Gateway token");
    }
  }
}

function redactKnownToken(error: unknown, token: string | undefined): Error {
  const message = error instanceof Error ? error.message : String(error);
  return new Error(token ? message.replaceAll(token, "[redacted Gateway token]") : message);
}

async function runStoppedCli(
  command: CliCommand,
  runtimeEnv: NodeJS.ProcessEnv,
  args: readonly string[],
): Promise<CliResult> {
  try {
    const { stdout, stderr } = await execFileAsync(
      command.executablePath,
      [...command.argsPrefix, ...args],
      {
        cwd: command.cwd,
        encoding: "utf8",
        env: { ...runtimeEnv, OPENCLAW_CLI: "1" },
        maxBuffer: 1024 * 1024,
        timeout: COMMAND_TIMEOUT_MS,
      },
    );
    return { exitCode: 0, stderr, stdout };
  } catch (error) {
    const failure = error as Error & {
      code?: number | string;
      stderr?: string;
      stdout?: string;
    };
    if (typeof failure.code !== "number") {
      throw error;
    }
    return {
      exitCode: failure.code,
      stderr: failure.stderr ?? "",
      stdout: failure.stdout ?? "",
    };
  }
}

export async function runCliStatusHealthSnapshots(repoRoot: string): Promise<JsonRecord> {
  const gatewayOwner = createQaGatewayChild();
  let knownToken: string | undefined;
  let result: JsonRecord | undefined;
  let failure: Error | undefined;
  try {
    const gateway = await gatewayOwner.start({
      repoRoot,
      command: {
        executablePath: process.execPath,
        argsPrefix: [path.join(repoRoot, "dist", "index.js")],
        cwd: repoRoot,
      },
      transportBaseUrl: "http://127.0.0.1:9",
      controlUiEnabled: false,
      onListening: (context) => {
        knownToken = context.token;
      },
    });
    const token = gateway.token;
    knownToken = token;
    const command = gateway.cliCommand;
    if (!command) {
      throw new Error("QA Gateway did not expose its shipped CLI command");
    }

    const healthyStatusText = await gateway.runCli(["status", "--json", "--timeout", "10000"]);
    const healthyHealthText = await gateway.runCli(["health", "--json", "--timeout", "10000"]);
    assertTokenAbsent(token, [healthyStatusText, healthyHealthText]);
    const healthyStatus = parseJsonRecord("healthy status", healthyStatusText);
    const healthyHealth = parseJsonRecord("healthy health", healthyHealthText);
    if (record(healthyStatus.gateway)?.reachable !== true) {
      throw new Error(`healthy status did not report a reachable Gateway: ${healthyStatusText}`);
    }
    if (healthyHealth.ok !== true) {
      throw new Error(`healthy health did not report a successful snapshot: ${healthyHealthText}`);
    }
    const runtimeEnv = { ...gateway.runtimeEnv };
    await gateway.stop({ keepTemp: true });

    const stoppedStatus = await runStoppedCli(command, runtimeEnv, [
      "status",
      "--json",
      "--timeout",
      "3000",
    ]);
    const stoppedHealth = await runStoppedCli(command, runtimeEnv, [
      "health",
      "--json",
      "--timeout",
      "3000",
    ]);
    const stoppedHumanStatus = await runStoppedCli(command, runtimeEnv, [
      "status",
      "--timeout",
      "3000",
    ]);
    const stoppedStatusJson = parseJsonRecord("stopped status", stoppedStatus.stdout);
    const stoppedHealthJson = parseJsonRecord("stopped health", stoppedHealth.stdout);
    const stoppedGateway = record(stoppedStatusJson.gateway);
    if (stoppedGateway?.reachable !== false || typeof stoppedGateway.error !== "string") {
      throw new Error(`stopped status did not report the Gateway as unreachable`);
    }
    const stoppedHealthError = record(stoppedHealthJson.error);
    if (
      stoppedHealth.exitCode === 0 ||
      stoppedHealthJson.ok !== false ||
      stoppedHealthError?.type !== "gateway_transport_error"
    ) {
      throw new Error(`stopped health did not report a transport failure`);
    }
    const humanOutput = `${stoppedHumanStatus.stdout}\n${stoppedHumanStatus.stderr}`;
    assertTokenAbsent(token, [
      stoppedStatus.stdout,
      stoppedStatus.stderr,
      stoppedHealth.stdout,
      stoppedHealth.stderr,
      humanOutput,
    ]);
    if (!humanOutput.includes(gateway.wsUrl)) {
      throw new Error("stopped human status did not identify the isolated Gateway target");
    }
    if (
      !/Fix reachability first:\s+openclaw\s+(?:--profile\s+\S+\s+)?gateway probe/u.test(
        humanOutput,
      )
    ) {
      throw new Error("stopped human status did not provide the gateway probe recovery command");
    }

    result = {
      healthy: {
        healthOk: healthyHealth.ok,
        statusReachable: record(healthyStatus.gateway)?.reachable,
      },
      stopped: {
        healthErrorType: stoppedHealthError.type,
        healthExitCode: stoppedHealth.exitCode,
        statusReachable: stoppedGateway.reachable,
      },
      tokenLeak: false,
    };
  } catch (error) {
    failure = redactKnownToken(error, knownToken);
  }

  const cleanup = await gatewayOwner.stop({ keepTemp: false });
  if (cleanup.errors.length > 0) {
    const cleanupFailure = new Error("CLI status and health fixture cleanup failed");
    failure = failure
      ? new AggregateError([failure, cleanupFailure], "CLI status and health scenario failed")
      : cleanupFailure;
  }
  if (failure) {
    throw failure;
  }
  if (!result) {
    throw new Error("CLI status and health scenario did not produce a result");
  }
  return result;
}

async function main(): Promise<void> {
  const repoRoot = process.cwd();
  const outputRoot = artifactBase(process.argv.slice(2));
  const startedAt = Date.now();
  const writer = createQaScriptEvidenceWriter({
    artifactBase: outputRoot,
    logFileName: "cli-status-health-snapshots.log",
    primaryModel: "none",
    providerMode: "mock-openai",
    repoRoot,
    target: {
      id: SCENARIO_ID,
      sourcePath: `qa/scenarios/cli/${SCENARIO_ID}.yaml`,
      title: "CLI status and health snapshots",
      codeRefs: [SOURCE_PATH, "src/commands/status.command.ts", "src/commands/health.ts"],
    },
  });
  try {
    const result = await runCliStatusHealthSnapshots(repoRoot);
    writer.appendLog(`${JSON.stringify(result)}\n`);
    await writer.write({ durationMs: Date.now() - startedAt, status: "pass" });
  } catch (error) {
    const details = error instanceof Error ? error.message : String(error);
    writer.appendLog(`${details}\n`);
    await writer.write({ details, durationMs: Date.now() - startedAt, status: "fail" });
    throw error;
  }
}

if (import.meta.url === new URL(process.argv[1] ?? "", "file:").href) {
  await main();
}
