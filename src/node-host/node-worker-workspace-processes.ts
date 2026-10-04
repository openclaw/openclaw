import { createHash, randomUUID } from "node:crypto";
import { resolveExecutablePath } from "../infra/executable-path.js";
import {
  decodeWindowsOutputBuffer,
  resolveWindowsConsoleEncoding,
} from "../infra/windows-encoding.js";
import {
  appendCapturedOutput,
  createCapturedOutputBuffers,
  finalizeCapturedOutput,
  type CapturedOutputBuffers,
} from "../process/exec-output.js";
import { runCommandWithTimeout } from "../process/exec.js";
import { getProcessSupervisor, type ManagedRun } from "../process/supervisor/index.js";
import type { RunExit } from "../process/supervisor/types.js";
import type { NodeWorkerEnvironmentStopInput } from "../worker/node-supervisor-protocol.js";
import {
  projectNodeWorkerWorkspaceExecResult,
  type NodeWorkerWorkspaceExecInput,
  type NodeWorkerWorkspaceExecResult,
} from "../worker/node-workspace-protocol.js";

const MAX_PROCESSES_PER_WORKSPACE = 32;
const MAX_OUTPUT_CHARS = 4_096;

type WorkspaceProcessStop = { epoch: number; open: boolean; settled?: Promise<void> };

type ProcessOwner = {
  key: string;
  gatewayNamespace: string;
  environmentId: string;
  sessionId: string;
  generation: number;
  workspaceDir: string;
  accepting: boolean;
  processes: Map<string, WorkspaceProcess>;
};
type WorkspaceProcess = {
  fingerprint: string;
  cleanup: () => Promise<void>;
  run?: ManagedRun;
  completion?: RunExit;
  settled: boolean;
  cleanupError?: Error;
  stdout: string;
  stderr: string;
  started: Promise<void>;
  settlement?: Promise<void>;
  output?: {
    stdout: CapturedOutputBuffers;
    stderr: CapturedOutputBuffers;
    windowsEncoding: string | null;
  };
  releaseWorkspace: () => void;
};

async function joinWorkspaceCleanup(operations: Promise<void>[]): Promise<void> {
  const failures = (await Promise.allSettled(operations)).flatMap((outcome) =>
    outcome.status === "rejected" ? [outcome.reason] : [],
  );
  if (failures.length > 0) {
    throw failures.length === 1
      ? failures[0]
      : new AggregateError(failures, "Workspace process cleanup failed");
  }
}

/** A workspace owns preview processes across tool calls and joins their trees before retirement. */
export class NodeWorkerWorkspaceProcesses {
  private readonly supervisor = getProcessSupervisor();
  private readonly owners = new Map<string, ProcessOwner>();
  private readonly stopped = new Map<string, WorkspaceProcessStop>();
  private readonly stopping = new Set<Promise<void>>();
  private closed = false;

  hasActiveWork(): boolean {
    return (
      this.stopping.size > 0 ||
      [...this.stopped.values()].some((marker) => !marker.open) ||
      [...this.owners.values()].some((owner) =>
        [...owner.processes.values()].some((process) => !process.settled),
      )
    );
  }

  /** Capture before workspace lookup can yield; stop revokes this admission, not the directory. */
  captureAdmission(
    input: Pick<NodeWorkerWorkspaceExecInput, "gatewayNamespace" | "environmentId">,
    generation: number,
  ): () => void {
    const key = JSON.stringify([input.gatewayNamespace, input.environmentId]);
    const admitted = this.stopped.get(key);
    const refused = admitted !== undefined && admitted.epoch >= generation && !admitted.open;
    return () => {
      const current = this.stopped.get(key);
      if (
        this.closed ||
        refused ||
        (current &&
          current.epoch >= generation &&
          (current !== admitted || current.epoch > generation || !current.open))
      ) {
        throw new Error("INVALID_REQUEST: workspace process owner has retired");
      }
    };
  }

  async executeForeground(params: {
    input: NodeWorkerWorkspaceExecInput;
    assertCurrent: () => void;
    workspaceDir: string;
    env: NodeJS.ProcessEnv;
    signal?: AbortSignal;
    timeoutMs: number;
    stdoutLimit: number;
    stderrLimit: number;
    retainWorkspace: () => () => void;
  }): Promise<NodeWorkerWorkspaceExecResult> {
    // Legacy callers retain their shipped executor, including detached lease helpers.
    if (!params.input.nativeProcessOwner) {
      const result = await runCommandWithTimeout(params.input.argv, {
        cwd: params.workspaceDir,
        baseEnv: params.env,
        ...(params.input.input === undefined ? {} : { input: params.input.input }),
        timeoutMs: params.timeoutMs,
        ...(params.signal ? { signal: params.signal } : {}),
        killProcessTree: true,
        requireProcessTreeExtinction: true,
        maxOutputBytes: { stdout: params.stdoutLimit, stderr: params.stderrLimit },
        terminateOnOutputLimit: true,
      });
      return projectNodeWorkerWorkspaceExecResult(params.workspaceDir, result);
    }
    return this.execute({
      ...params,
      input: {
        ...params.input,
        process: { action: "start", processId: "foreground-" + randomUUID() },
      },
      foreground: {
        timeoutMs: params.timeoutMs,
        stdoutLimit: params.stdoutLimit,
        stderrLimit: params.stderrLimit,
      },
    });
  }

  async execute(params: {
    input: NodeWorkerWorkspaceExecInput;
    assertCurrent: () => void;
    workspaceDir: string;
    env: NodeJS.ProcessEnv;
    signal?: AbortSignal;
    retainWorkspace: () => () => void;
    foreground?: { timeoutMs: number; stdoutLimit: number; stderrLimit: number };
  }): Promise<NodeWorkerWorkspaceExecResult> {
    const { input, workspaceDir, signal } = params;
    const operation = input.process!;
    const key = JSON.stringify([
      input.gatewayNamespace,
      input.environmentId,
      input.sessionId,
      input.generation,
    ]);
    const assertCurrent = () => {
      signal?.throwIfAborted();
      params.assertCurrent();
    };
    assertCurrent();
    let owner = this.owners.get(key);
    if (owner && (!owner.accepting || owner.workspaceDir !== workspaceDir)) {
      throw new Error("INVALID_REQUEST: workspace process binding changed");
    }
    let process = owner?.processes.get(operation.processId);
    if (operation.action === "start") {
      const fingerprint = createHash("sha256")
        .update(JSON.stringify([input.argv, input.input ?? null]))
        .digest("hex");
      if (process && process.fingerprint !== fingerprint) {
        throw new Error("INVALID_REQUEST: processId already belongs to a different command");
      }
      if (!process) {
        const executable = resolveExecutablePath(input.argv[0]!, {
          cwd: workspaceDir,
          env: params.env,
          useCache: false,
        });
        if (!executable) {
          throw new Error(
            "INVALID_REQUEST: workspace process executable is unavailable; install it or choose a command on the machine's PATH",
          );
        }
        if (!owner) {
          owner = {
            key,
            gatewayNamespace: input.gatewayNamespace,
            environmentId: input.environmentId,
            sessionId: input.sessionId,
            generation: input.generation,
            workspaceDir,
            accepting: true,
            processes: new Map(),
          };
          this.owners.set(key, owner);
        }
        if (
          !params.foreground &&
          [...owner.processes.values()].filter((entry) => !entry.output).length >=
            MAX_PROCESSES_PER_WORKSPACE
        ) {
          throw new Error(
            "INVALID_REQUEST: workspace process limit reached; stop the environment before starting more processes",
          );
        }
        const boundOwner = owner;
        const scopeKey = JSON.stringify([
          "worker-workspace",
          workspaceDir,
          key,
          operation.processId,
        ]);
        const created: WorkspaceProcess = {
          fingerprint,
          cleanup: this.supervisor.acquireScopeCleanup(scopeKey, { processTree: "required-all" }),
          stdout: "",
          stderr: "",
          settled: false,
          started: Promise.resolve(),
          releaseWorkspace: params.retainWorkspace(),
          ...(params.foreground
            ? {
                output: {
                  stdout: createCapturedOutputBuffers(),
                  stderr: createCapturedOutputBuffers(),
                  windowsEncoding: resolveWindowsConsoleEncoding(),
                },
              }
            : {}),
        };
        owner.processes.set(operation.processId, created);
        created.started = (async () => {
          const runId = randomUUID();
          const abortStartup = () => this.supervisor.cancel(runId);
          const append = (stream: "stdout" | "stderr", chunk: string) => {
            if (!created.output) {
              created[stream] = (created[stream] + chunk).slice(-MAX_OUTPUT_CHARS);
            }
          };
          const capture = (stream: "stdout" | "stderr", bytes: Buffer) => {
            const output = created.output;
            const limit =
              stream === "stdout" ? params.foreground?.stdoutLimit : params.foreground?.stderrLimit;
            if (!output || limit === undefined) {
              return;
            }
            appendCapturedOutput(output[stream], bytes, limit, "tail");
            if (output[stream].truncatedBytes > 0) {
              this.supervisor.cancel(runId);
            }
          };
          signal?.addEventListener("abort", abortStartup, { once: true });
          try {
            const run = await this.supervisor.spawn({
              mode: "child",
              runId,
              argv: [executable, ...input.argv.slice(1)],
              scopeKey,
              cwd: workspaceDir,
              env: params.env,
              exactEnv: true,
              ...(input.input === undefined ? {} : { input: input.input }),
              captureOutput: false,
              ...(params.foreground
                ? {
                    timeoutMs: params.foreground.timeoutMs,
                    onStdoutRaw: (bytes: Buffer) => capture("stdout", bytes),
                    onStderrRaw: (bytes: Buffer) => capture("stderr", bytes),
                  }
                : {}),
              onStdout: (chunk) => append("stdout", chunk),
              onStderr: (chunk) => append("stderr", chunk),
              assertCurrent: () => {
                assertCurrent();
                if (!boundOwner.accepting) {
                  throw new Error("workspace process owner is stopping");
                }
              },
            });
            created.run = run;
            // Spawn admission is run-bound; the accepted process is environment-bound.
            // Later turn completion must not kill an app the user is still viewing.
            created.settlement = run
              .wait()
              .then(async (result) => {
                created.completion = result;
                await this.joinExtinction(created);
              })
              .catch((error: unknown) => {
                created.cleanupError =
                  error instanceof Error ? error : new Error("Workspace process cleanup failed");
              });
          } catch (error) {
            // A rejected spawn can still own a native child or private input pipe.
            // Keep the workspace pinned until the supervisor settles that scope.
            try {
              await created.cleanup();
              boundOwner.processes.delete(operation.processId);
              created.releaseWorkspace();
            } catch (cleanupError) {
              throw new AggregateError(
                [error, cleanupError],
                "Workspace process startup cleanup failed",
                { cause: cleanupError },
              );
            }
            throw error;
          } finally {
            signal?.removeEventListener("abort", abortStartup);
          }
        })();
        process = created;
      }
    }
    if (!process) {
      throw new Error("INVALID_REQUEST: unknown workspace process");
    }
    await process.started;
    if (params.foreground) {
      const accepted = process;
      const cancelAccepted = () => accepted.run!.cancel();
      signal?.addEventListener("abort", cancelAccepted, { once: true });
      try {
        if (signal?.aborted) {
          cancelAccepted();
        }
        await process.settlement;
        if (!process.cleanupError) {
          await process.cleanup();
        }
      } finally {
        signal?.removeEventListener("abort", cancelAccepted);
      }
      if (process.output) {
        for (const stream of ["stdout", "stderr"] as const) {
          process[stream] = decodeWindowsOutputBuffer({
            buffer: finalizeCapturedOutput(process.output[stream], "tail"),
            windowsEncoding: process.output.windowsEncoding,
          });
        }
      }
      if (process.settled) {
        owner?.processes.delete(operation.processId);
        if (owner?.processes.size === 0) {
          this.owners.delete(owner.key);
        }
      }
    } else {
      assertCurrent();
    }
    if (operation.action === "stop") {
      process.run!.cancel();
      process.completion = await process.run!.wait();
      await this.joinExtinction(process);
      assertCurrent();
    }
    if (process.cleanupError) {
      throw process.cleanupError;
    }
    const completion = process.completion;
    return {
      workspaceDir,
      stdout: process.stdout,
      stderr: process.stderr,
      code: completion?.timedOut && !completion.exitCode ? 124 : (completion?.exitCode ?? null),
      signal: typeof completion?.exitSignal === "string" ? completion.exitSignal : null,
      killed: completion?.reason === "manual-cancel" || completion?.timedOut === true,
      termination: completion?.timedOut
        ? "timeout"
        : completion?.reason === "manual-cancel" || completion?.reason === "signal"
          ? "signal"
          : "exit",
      ...(params.foreground
        ? {
            killIssuedByAbort: signal?.aborted === true || undefined,
            stdoutTruncatedBytes: process.output?.stdout.truncatedBytes || undefined,
            stderrTruncatedBytes: process.output?.stderr.truncatedBytes || undefined,
            noOutputTimedOut: false,
            outputLimitExceeded:
              Boolean(
                process.output?.stdout.truncatedBytes || process.output?.stderr.truncatedBytes,
              ) || undefined,
          }
        : {
            process: {
              processId: operation.processId,
              state: completion ? ("exited" as const) : ("running" as const),
            },
          }),
    };
  }

  async stopEnvironment(
    input: NodeWorkerEnvironmentStopInput,
    stopExecution?: () => Promise<void>,
  ): Promise<void> {
    const environmentKey = JSON.stringify([input.gatewayNamespace, input.environmentId]);
    const previous = this.stopped.get(environmentKey);
    const marker: WorkspaceProcessStop = { epoch: input.ownerEpoch, open: false };
    if (!previous || previous.epoch <= input.ownerEpoch) {
      this.stopped.set(environmentKey, marker);
    }
    const owners = [...this.owners.values()].filter(
      (owner) =>
        owner.gatewayNamespace === input.gatewayNamespace &&
        owner.environmentId === input.environmentId &&
        owner.generation <= input.ownerEpoch &&
        owner.sessionId === input.sessionId,
    );
    // Failed cleanup keeps admission closed; retries join the exact earlier stop.
    const stopping = (previous?.settled ?? Promise.resolve())
      .catch(() => undefined)
      .then(() => this.stopOwners(owners, stopExecution))
      .then(() => {
        marker.open = true;
      });
    marker.settled = stopping;
    this.stopping.add(stopping);
    return stopping.finally(() => this.stopping.delete(stopping));
  }

  async close(): Promise<void> {
    this.closed = true;
    await joinWorkspaceCleanup([...this.stopping, this.stopOwners([...this.owners.values()])]);
  }

  private async joinExtinction(process: WorkspaceProcess): Promise<void> {
    if (!process.run?.waitForExtinction) {
      throw new Error("Workspace process cleanup cannot confirm descendant extinction");
    }
    const result = await process.run.waitForExtinction();
    if (result?.status === "uncertain") {
      throw new Error(`Workspace process cleanup is uncertain: ${result.reason}`);
    }
    process.settled = true;
    process.releaseWorkspace();
  }

  private async stopOwners(
    owners: ProcessOwner[],
    stopExecution?: () => Promise<void>,
  ): Promise<void> {
    for (const owner of owners) {
      owner.accepting = false;
    }
    const cleanup = joinWorkspaceCleanup(
      owners.map(async (owner) => {
        await joinWorkspaceCleanup(
          [...owner.processes.values()].map((process) => process.cleanup()),
        );
        for (const process of owner.processes.values()) {
          process.releaseWorkspace();
        }
        this.owners.delete(owner.key);
      }),
    );
    // Worker cleanup still runs after a workspace cleanup failure.
    await cleanup.catch(() => undefined);
    await joinWorkspaceCleanup([cleanup, ...(stopExecution ? [stopExecution()] : [])]);
  }
}
