import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { toErrorObject } from "@openclaw/normalization-core/error-coercion";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { sanitizeForLog, stripAnsi } from "../../packages/terminal-core/src/ansi.js";
import {
  hasUnjoinedWork,
  inspectManagedProcessGroup,
  runManagedCommand,
} from "../../scripts/lib/managed-child-process.mts";
import { redactSupportString } from "../logging/diagnostic-support-redaction.js";
import { formatCommandOutput } from "../process/command-error.js";

type ServiceObservation = "install" | "status";

function captureServiceOutput(
  kind: ServiceObservation,
  stdout: string,
  truncated: boolean,
  diagnostic: (value: string) => string,
) {
  if (truncated) {
    return { kind, unavailable: "capture limit exceeded; output withheld" };
  }
  let value: Record<string, unknown> | undefined;
  try {
    value = asOptionalRecord(JSON.parse(stdout));
  } catch {
    return { kind, unavailable: "response is not JSON" };
  }
  if (!value) {
    return { kind, unavailable: "response is not a JSON object" };
  }
  // Only these fixed diagnostic fields may cross into retained evidence, never config/auth/argv.
  const fields = (input: unknown, keys: string[]) => {
    const source = asOptionalRecord(input);
    return Object.fromEntries(
      keys.map((key) => {
        const field = source?.[key];
        return [
          key,
          typeof field === "string"
            ? diagnostic(field)
            : typeof field === "number" || typeof field === "boolean" || field === null
              ? field
              : undefined,
        ];
      }),
    );
  };
  const service = asOptionalRecord(value.service);
  const common = { kind };
  if (kind === "install") {
    return {
      ...common,
      ...fields(value, ["action", "ok", "result", "message", "error"]),
      service: fields(service, ["label", "loaded", "loadedText", "notLoadedText"]),
      warnings: Array.isArray(value.warnings)
        ? value.warnings
            .slice(0, 5)
            .filter((warning): warning is string => typeof warning === "string")
            .map(diagnostic)
        : undefined,
    };
  }
  const runtime = asOptionalRecord(service?.runtime);
  const rpc = asOptionalRecord(value.rpc);
  return {
    ...common,
    service: {
      ...fields(service, ["loaded", "inspectionReason"]),
      loadState: fields(service?.loadState, ["status", "detail", "inspectionReason"]),
      runtime: {
        ...fields(runtime, [
          "status",
          "state",
          "pid",
          "detail",
          "inspectionReason",
          "missingUnit",
          "lastRunTime",
          "lastRunResult",
        ]),
        inspectionFailure: fields(runtime?.inspectionFailure, ["code", "detail", "timeoutMs"]),
      },
    },
    rpc: {
      ...fields(rpc, ["ok", "kind", "url", "error", "gatewayReached"]),
      server: fields(rpc?.server, ["version", "buildId"]),
    },
    gateway: fields(value.gateway, ["port", "version", "bindMode", "bindHost", "probeUrl"]),
    port: fields(value.port, ["port", "status"]),
  };
}

export type CommandRecord = {
  args: string[];
  launcherPid: number | null;
  beforeCleanup: ReturnType<typeof inspectManagedProcessGroup> | undefined;
  code: number | null;
  signal: string | null;
  joined: boolean;
  elapsedMs: number;
  failureOutput?: { stdout: string; stderr: string; captureTruncated: boolean };
  serviceOutput?: ReturnType<typeof captureServiceOutput>;
};
export async function run(
  args: string[],
  env: NodeJS.ProcessEnv,
  cwd: string,
  records: CommandRecord[],
  expectedExit = 0,
  signal?: AbortSignal,
  options: {
    observeService?: ServiceObservation;
    commandBudget?: "published-update";
  } = {},
) {
  const { observeService } = options;
  const started = performance.now();
  let child: ChildProcess | undefined;
  let stdout = "";
  let stderr = "";
  let truncated = false;
  let code: number | null = null;
  let exitSignal: NodeJS.Signals | null = null;
  let beforeCleanup: ReturnType<typeof inspectManagedProcessGroup> | undefined;
  let result: number | undefined;
  let failure: Error | undefined;
  try {
    result = await runManagedCommand({
      bin: process.execPath,
      args,
      env,
      cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      timeoutMs: options.commandBudget === "published-update" ? 360_000 : 180_000,
      signal,
      onReady(launched) {
        child = launched;
        launched.stdout?.on("data", (chunk: Buffer) => {
          stdout += chunk.toString();
          if (stdout.length > 262144) {
            truncated = true;
            stdout = stdout.slice(-262144);
          }
        });
        launched.stderr?.on("data", (chunk: Buffer) => {
          stderr += chunk.toString();
          if (stderr.length > 262144) {
            truncated = true;
            stderr = stderr.slice(-262144);
          }
        });
        launched.once("exit", (exitCode, receivedSignal) => {
          code = exitCode;
          exitSignal = receivedSignal;
          beforeCleanup = inspectManagedProcessGroup(launched, { errorPolicy: "indeterminate" });
        });
      },
    });
  } catch (error) {
    failure = toErrorObject(error, "Installed Scheduled Task fixture failed");
  }
  const afterCleanup = child
    ? inspectManagedProcessGroup(child, { errorPolicy: "indeterminate" })
    : undefined;
  const failed =
    failure ||
    afterCleanup !== "dead" ||
    beforeCleanup !== "dead" ||
    truncated ||
    exitSignal !== null ||
    code !== expectedExit ||
    result !== expectedExit;
  const redaction = { env, stateDir: env.OPENCLAW_STATE_DIR ?? cwd };
  const diagnostic = (value: string) => {
    // A truncated capture may have lost the field name needed for redaction.
    if (truncated) {
      return "[output withheld: capture limit exceeded]";
    }
    const normalized = stripAnsi(value)
      .split(/\r\n|[\r\n]/u)
      .map((line) => sanitizeForLog(line.replaceAll("\t", " ")))
      .join("\n");
    return formatCommandOutput(
      redactSupportString(normalized, redaction, { maxLength: Number.MAX_SAFE_INTEGER }),
      2_000,
    );
  };
  const failureOutput = failed
    ? {
        stdout: diagnostic(stdout),
        stderr: diagnostic(stderr),
        captureTruncated: truncated,
      }
    : undefined;
  records.push({
    args,
    launcherPid: child?.pid ?? null,
    code,
    signal: exitSignal,
    beforeCleanup,
    joined: afterCleanup === "dead" && !hasUnjoinedWork(failure),
    elapsedMs: performance.now() - started,
    ...(failureOutput ? { failureOutput } : {}),
    ...(observeService
      ? {
          serviceOutput: captureServiceOutput(observeService, stdout, truncated, diagnostic),
        }
      : {}),
  });
  if (child && afterCleanup !== "dead") {
    // Keep the existing fixture lifetime's claim when physical cleanup is uncertain.
    throw Object.assign(
      new Error("Installed command descendant cleanup is unverified", { cause: failure }),
      {
        processTreeState: "indeterminate",
      },
    );
  }
  if (failure) {
    throw failure;
  }
  assert.equal(beforeCleanup, "dead", "Installed command required descendant cleanup after exit");
  assert.equal(truncated, false, "Command output was truncated");
  assert.equal(exitSignal, null);
  const details = failureOutput ? JSON.stringify(failureOutput, null, 2) : "";
  assert.equal(code, expectedExit, details);
  assert.equal(result, expectedExit, details);
  return stdout;
}
