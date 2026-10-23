import assert from "node:assert/strict";
import childProcess, { type ChildProcess, type SpawnSyncReturns } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { z } from "zod";
import { sanitizeForLog, stripAnsi } from "../../packages/terminal-core/src/ansi.js";
import {
  hasUnjoinedWork,
  inspectManagedProcessGroup,
  runManagedCommand,
} from "../../scripts/lib/managed-child-process.mts";
import { isMainModule } from "../infra/is-main.js";
import { WINDOWS_POWERSHELL_COLD_SPAWN_TIMEOUT_MS } from "../infra/windows-powershell-spawn.js";
import {
  normalizeSupportDiagnosticErrorCode,
  redactSupportString,
} from "../logging/diagnostic-support-redaction.js";
import { boundedEnv, prefix, readInput } from "./schtasks.installed-package.test-support.js";
import { resolveServiceManagerEnv } from "./service-process-env.js";

const currentFile = fileURLToPath(import.meta.url);
const taskPattern = /^OpenClaw-context-[0-9a-f-]{36}$/u;
const order = [
  "inherited-direct",
  "bounded-direct",
  "inherited-managed",
  "bounded-managed",
] as const;
const outputSchema = z.object({ text: z.string().max(4096), withheld: z.boolean() });
const probeSchema = z.object({
  status: z.enum(["missing", "found", "unknown"]),
  diagnostic: z
    .discriminatedUnion("kind", [
      z.object({ kind: z.literal("timeout"), timeoutMs: z.number() }),
      z.object({ kind: z.literal("spawn"), errno: z.number().optional() }),
      z.object({ kind: z.literal("invalid-response") }),
      z.object({
        kind: z.literal("native"),
        exitCode: z.number().nullable(),
        hresult: z.number().optional(),
      }),
    ])
    .optional(),
});
const observationSchema = z.object({
  elapsedMs: z.number(),
  probe: probeSchema.nullable(),
  errorCode: z.string().nullable(),
  captureFailed: z.boolean(),
  spawnCount: z.number(),
  spawns: z
    .array(
      z.object({
        elapsedMs: z.number(),
        status: z.number().nullable(),
        signal: z.string().nullable(),
        errorCode: z.string().nullable(),
        stdout: outputSchema,
        stderr: outputSchema,
      }),
    )
    .max(4),
});
type Observation = z.infer<typeof observationSchema>;

function errorCode(error: unknown) {
  return error && typeof error === "object" && "code" in error && typeof error.code === "string"
    ? (normalizeSupportDiagnosticErrorCode(error.code) ?? null)
    : null;
}

function safeOutput(
  value: string | Buffer | null | undefined,
  env: NodeJS.ProcessEnv,
  truncated = false,
) {
  if (truncated) {
    return { text: "[output withheld: capture truncated]", withheld: true };
  }
  const normalized = stripAnsi(value?.toString() ?? "")
    .split(/\r\n|[\r\n]/u)
    .filter((line) => !/encodedcommand/iu.test(line))
    .map((line) => sanitizeForLog(line.replaceAll("\t", " ")))
    .join("\n");
  // An unexpected existing Task is a failure, never permission to collect its actions.
  if (/"(?:actions|arguments|taskPath)"\s*:/iu.test(normalized)) {
    return { text: "[output withheld: unexpected Task definition]", withheld: true };
  }
  const redacted = redactSupportString(
    normalized,
    {
      env,
      stateDir: env.OPENCLAW_STATE_DIR ?? process.cwd(),
    },
    { maxLength: Number.MAX_SAFE_INTEGER },
  );
  return redacted.length > 4096
    ? { text: "[output withheld: sanitized output exceeds bound]", withheld: true }
    : { text: redacted, withheld: false };
}

async function observeProbe(taskName: string, env: NodeJS.ProcessEnv): Promise<Observation> {
  const previousEnv = process.env;
  const original = childProcess.spawnSync;
  const started = performance.now();
  const observation: Observation = {
    elapsedMs: 0,
    probe: null,
    errorCode: null,
    captureFailed: false,
    spawnCount: 0,
    spawns: [],
  };
  process.env = env;
  childProcess.spawnSync = new Proxy(original, {
    apply(target, receiver, args) {
      const spawnStarted = performance.now();
      let result: SpawnSyncReturns<string | Buffer> | undefined;
      let thrown: unknown;
      try {
        // Forward untouched options and return the exact native result to the production reader.
        result = Reflect.apply(target, receiver, args);
        return result;
      } catch (error) {
        thrown = error;
        throw error;
      } finally {
        observation.spawnCount += 1;
        try {
          if (observation.spawns.length < 4) {
            const truncated = errorCode(result?.error) === "ENOBUFS";
            observation.spawns.push({
              elapsedMs: performance.now() - spawnStarted,
              status: result?.status ?? null,
              signal: result?.signal ?? null,
              errorCode: errorCode(result?.error ?? thrown),
              stdout: safeOutput(result?.stdout, env, truncated),
              stderr: safeOutput(result?.stderr, env, truncated),
            });
          }
        } catch {
          // Observation failure must never change the native reader's result or exception.
          observation.captureFailed = true;
        }
      }
    },
  });
  syncBuiltinESMExports();
  try {
    const { probeScheduledTaskState } = await import("./schtasks-state-probe.js");
    const probe = probeScheduledTaskState(taskName);
    observation.probe =
      probe.status === "unknown"
        ? { status: probe.status, diagnostic: probe.diagnostic }
        : { status: probe.status };
  } catch (error) {
    observation.errorCode = errorCode(error);
  } finally {
    childProcess.spawnSync = original;
    syncBuiltinESMExports();
    process.env = previousEnv;
    observation.elapsedMs = performance.now() - started;
  }
  return observation;
}

async function managedProbe(taskName: string, env: NodeJS.ProcessEnv, cwd: string) {
  let child: ChildProcess | undefined;
  let stdout = "";
  let stderr = "";
  let truncated = false;
  let failure: unknown;
  let code: number | null = null;
  let exitSignal: NodeJS.Signals | null = null;
  const started = performance.now();
  const capture = (stream: "stdout" | "stderr", chunk: Buffer) => {
    if (truncated) {
      return;
    }
    if (stream === "stdout") {
      stdout += chunk.toString();
    } else {
      stderr += chunk.toString();
    }
    if (stdout.length + stderr.length > 65536) {
      truncated = true;
      stdout = "";
      stderr = "";
    }
  };
  try {
    code = await runManagedCommand({
      bin: process.execPath,
      args: [
        "--import",
        pathToFileURL(path.resolve("scripts/tsx.mjs")).href,
        currentFile,
        "--probe-child",
        taskName,
      ],
      cwd,
      env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      timeoutMs: 180_000,
      onReady(launched) {
        child = launched;
        launched.stdout?.on("data", (chunk: Buffer) => capture("stdout", chunk));
        launched.stderr?.on("data", (chunk: Buffer) => capture("stderr", chunk));
        launched.once("exit", (_code, signal) => {
          exitSignal = signal;
        });
      },
    });
  } catch (error) {
    failure = error;
  }
  const group = child
    ? inspectManagedProcessGroup(child, { errorPolicy: "indeterminate" })
    : undefined;
  let observation: Observation | null = null;
  if (!truncated) {
    try {
      observation = observationSchema.parse(JSON.parse(stdout));
    } catch {
      /* Preserve the failed child output below. */
    }
  }
  return {
    observation,
    elapsedMs: performance.now() - started,
    code,
    signal: exitSignal,
    errorCode: errorCode(failure),
    processGroup: group ?? "not-started",
    joined: group === "dead" && !hasUnjoinedWork(failure),
    stdout: observation ? undefined : safeOutput(stdout, env, truncated),
    stderr: safeOutput(stderr, env, truncated),
  };
}

function environmentShape(env: NodeJS.ProcessEnv) {
  const moduleCache = Object.entries(env).find(
    ([key]) => key.toUpperCase() === "PSMODULEANALYSISCACHEPATH",
  )?.[1];
  return {
    keys: Object.keys(env).toSorted(),
    moduleAnalysisCachePath: {
      kind:
        moduleCache === undefined
          ? "absent"
          : moduleCache === ""
            ? "empty"
            : path.win32.isAbsolute(moduleCache)
              ? "absolute"
              : "relative",
      sha256:
        moduleCache === undefined
          ? undefined
          : createHash("sha256").update(moduleCache).digest("hex"),
    },
  };
}

async function main(inputPath: string) {
  const input = await readInput(inputPath);
  assert.equal(input.sourceSha, input.candidate.packageSourceSha);
  assert.equal(
    childProcess
      .execFileSync("git", ["--no-optional-locks", "rev-parse", "HEAD"], { encoding: "utf8" })
      .trim(),
    input.toolingSha,
  );
  childProcess.execFileSync("git", ["--no-optional-locks", "diff", "--quiet", "HEAD", "--"]);
  const managedCwd = await fs.realpath(path.join(input.stateRoot, "fresh"));
  const taskName = `OpenClaw-context-${randomUUID()}`;
  const root = path.join(input.stateRoot, `powershell-context-${randomUUID()}`);
  await fs.mkdir(root);
  const rows: Array<{
    context: (typeof order)[number];
    environment: ReturnType<typeof environmentShape>;
    result: Awaited<ReturnType<typeof managedProbe>> | { observation: Observation; joined: true };
    passed: boolean;
    cleanup: "removed" | "retained-unjoined" | "failed";
    cleanupError: string | null;
  }> = [];
  let rootCleanup: "pending" | "removed" | "retained" = "pending";
  const reportPath = path.resolve(".artifacts/windows-schtasks/powershell-context.json");
  const save = () =>
    fs.writeFile(
      reportPath,
      JSON.stringify(
        {
          scope: "post-failure read-only native context diagnostic; not acceptance proof",
          contextLimit:
            "Direct probes run in this workflow diagnostic Node process, not the original Vitest worker. Managed probes reuse its command/Job owner but have different ancestors. Serial ordering can warm shared OS caches despite separate bounded roots.",
          sourceSha: input.sourceSha,
          toolingSha: input.toolingSha,
          runtime: input.runtime,
          packageSha256: input.candidate.sha256,
          taskName,
          probeTimeoutMs: WINDOWS_POWERSHELL_COLD_SPAWN_TIMEOUT_MS,
          managedTimeoutMs: 180_000,
          order,
          rows,
          rootCleanup,
        },
        null,
        2,
      ),
    );
  const inherited = resolveServiceManagerEnv(process.env);
  for (const context of order) {
    const directory = path.join(root, context);
    await fs.mkdir(directory);
    for (const name of ["appdata", "local-appdata", "tmp", "npm-cache", "state"]) {
      await fs.mkdir(path.join(directory, name));
    }
    const env = context.startsWith("bounded")
      ? resolveServiceManagerEnv(boundedEnv(directory, prefix(input, "fresh")))
      : inherited;
    const managed = context.endsWith("managed");
    const result: (typeof rows)[number]["result"] = managed
      ? await managedProbe(taskName, env, managedCwd)
      : { observation: await observeProbe(taskName, env), joined: true };
    let cleanup: "removed" | "retained-unjoined" | "failed" = "retained-unjoined";
    let cleanupError: string | null = null;
    if (result.joined) {
      try {
        await fs.rm(directory, { recursive: true });
        cleanup = "removed";
      } catch (error) {
        cleanup = "failed";
        cleanupError = errorCode(error);
      }
    }
    const passed =
      result.observation?.probe?.status === "missing" &&
      result.observation.spawnCount === 1 &&
      !result.observation.captureFailed &&
      result.joined &&
      cleanup === "removed" &&
      (!managed || ("code" in result && result.code === 0 && result.signal === null));
    rows.push({
      context,
      environment: environmentShape(env),
      result,
      passed,
      cleanup,
      cleanupError,
    });
    await save();
    // An indeterminate managed group cannot overlap the next control or lose its inputs.
    if (!result.joined) {
      break;
    }
  }
  rootCleanup = "retained";
  if (rows.every((row) => row.cleanup === "removed")) {
    try {
      await fs.rmdir(root);
      rootCleanup = "removed";
    } catch {
      /* Retain the failed cleanup in the report. */
    }
  }
  await save();
  assert.equal(rows.length, order.length, "Context diagnostic stopped after unjoined work");
  assert.equal(rootCleanup, "removed", "Context diagnostic directory cleanup failed");
  assert.ok(
    rows.every((row) => row.passed),
    "Native context probe was not confirmed missing; inspect powershell-context.json",
  );
}

if (isMainModule({ currentFile, env: {} })) {
  if (process.argv[2] === "--probe-child") {
    assert.equal(process.argv.length, 4);
    assert.match(process.argv[3] ?? "", taskPattern);
    const observation = await observeProbe(process.argv[3]!, process.env);
    console.log(JSON.stringify(observation));
    if (
      observation.probe?.status !== "missing" ||
      observation.spawnCount !== 1 ||
      observation.captureFailed
    ) {
      process.exitCode = 1;
    }
  } else {
    assert.equal(process.argv.length, 3);
    assert.ok(process.argv[2]);
    await main(process.argv[2]);
  }
}
