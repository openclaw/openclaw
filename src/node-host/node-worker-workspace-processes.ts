import { createHash, randomUUID } from "node:crypto";
import { resolveExecutablePath } from "../infra/executable-path.js";
import { getProcessSupervisor, type ManagedRun } from "../process/supervisor/index.js";
import type { RunExit } from "../process/supervisor/types.js";
import type {
  NodeWorkerWorkspaceExecInput,
  NodeWorkerWorkspaceExecResult,
} from "../worker/node-workspace-protocol.js";

const MAX_PROCESSES_PER_WORKSPACE = 32;
const MAX_OUTPUT_CHARS = 4_096;

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
  releaseWorkspace: () => void;
};

/** A workspace owns preview processes across tool calls and joins their trees before retirement. */
export class NodeWorkerWorkspaceProcesses {
  private readonly supervisor = getProcessSupervisor();
  private readonly owners = new Map<string, ProcessOwner>();
  private readonly stopped = new Map<string, number>();
  private closed = false;

  hasActiveWork(): boolean {
    return [...this.owners.values()].some((owner) =>
      [...owner.processes.values()].some((process) => !process.settled),
    );
  }

  async execute(params: {
    input: NodeWorkerWorkspaceExecInput;
    workspaceDir: string;
    env: NodeJS.ProcessEnv;
    signal?: AbortSignal;
    retainWorkspace: () => () => void;
  }): Promise<NodeWorkerWorkspaceExecResult> {
    const { input, workspaceDir, signal } = params;
    const operation = input.process!;
    const environmentKey = JSON.stringify([input.gatewayNamespace, input.environmentId]);
    const key = JSON.stringify([
      input.gatewayNamespace,
      input.environmentId,
      input.sessionId,
      input.generation,
    ]);
    const assertCurrent = () => {
      signal?.throwIfAborted();
      if (this.closed || (this.stopped.get(environmentKey) ?? -1) >= input.generation) {
        throw new Error("INVALID_REQUEST: workspace process owner has retired");
      }
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
        if (owner.processes.size >= MAX_PROCESSES_PER_WORKSPACE) {
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
        };
        owner.processes.set(operation.processId, created);
        created.started = (async () => {
          const runId = randomUUID();
          const abortStartup = () => this.supervisor.cancel(runId);
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
              onStdout: (chunk) => {
                created.stdout = (created.stdout + chunk).slice(-MAX_OUTPUT_CHARS);
              },
              onStderr: (chunk) => {
                created.stderr = (created.stderr + chunk).slice(-MAX_OUTPUT_CHARS);
              },
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
            void run
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
    assertCurrent();
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
      code: completion?.exitCode ?? null,
      signal: typeof completion?.exitSignal === "string" ? completion.exitSignal : null,
      killed: completion?.reason === "manual-cancel",
      termination:
        completion?.reason === "manual-cancel" || completion?.reason === "signal"
          ? "signal"
          : "exit",
      process: { processId: operation.processId, state: completion ? "exited" : "running" },
    };
  }

  async stopEnvironment(input: {
    gatewayNamespace: string;
    environmentId: string;
    ownerEpoch: number;
    sessionId?: string;
  }): Promise<void> {
    const environmentKey = JSON.stringify([input.gatewayNamespace, input.environmentId]);
    this.stopped.set(
      environmentKey,
      Math.max(this.stopped.get(environmentKey) ?? -1, input.ownerEpoch),
    );
    const owners = [...this.owners.values()].filter(
      (owner) =>
        owner.gatewayNamespace === input.gatewayNamespace &&
        owner.environmentId === input.environmentId &&
        owner.generation <= input.ownerEpoch &&
        (!input.sessionId || owner.sessionId === input.sessionId),
    );
    await this.stopOwners(owners);
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.stopOwners([...this.owners.values()]);
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

  private async stopOwners(owners: ProcessOwner[]): Promise<void> {
    for (const owner of owners) {
      owner.accepting = false;
    }
    const outcomes = await Promise.allSettled(
      owners.map(async (owner) => {
        const processOutcomes = await Promise.allSettled(
          [...owner.processes.values()].map((process) => process.cleanup()),
        );
        const errors = processOutcomes.flatMap((outcome) =>
          outcome.status === "rejected" ? [outcome.reason] : [],
        );
        if (errors.length) {
          throw new AggregateError(errors, "Workspace process cleanup failed");
        }
        for (const process of owner.processes.values()) {
          process.releaseWorkspace();
        }
        this.owners.delete(owner.key);
      }),
    );
    const errors = outcomes.flatMap((outcome) =>
      outcome.status === "rejected" ? [outcome.reason] : [],
    );
    if (errors.length) {
      throw new AggregateError(errors, "Workspace process cleanup failed");
    }
  }
}
