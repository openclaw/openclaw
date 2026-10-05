import fs from "node:fs";
import path from "node:path";
import { racePromiseWithAbortSignal } from "../infra/abort-signal.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  NODE_WORKSPACE_REPOSITORY_COMMAND,
  type NodeWorkerWorkspaceExecInput,
} from "../worker/node-workspace-protocol.js";

type Identity = {
  environmentId: string;
  sessionId: string;
  sessionKey: string;
  generation: number;
};
type Repository = { workspaceId: string; revision: number; branch: string; baseCommit?: string };
type State = Identity &
  Repository & {
    status: "pending" | "ready" | "failed";
    settled: ReturnType<typeof createDeferredCore<void>>;
  };

/** The node workspace owns one preparation incarnation; matching IDs cannot revive a retired one. */
export class NodeWorkerRepositoryReadiness {
  private readonly entries = new Map<string, State>();
  private closed = false;

  execute(
    input: NodeWorkerWorkspaceExecInput,
    assertOwner: () => void,
    signal?: AbortSignal,
  ): string | undefined {
    if (!input.repositoryPreparation) {
      return undefined;
    }
    if (
      input.argv.length !== 1 ||
      input.argv[0] !== NODE_WORKSPACE_REPOSITORY_COMMAND ||
      !input.sessionKey
    ) {
      throw new Error("INVALID_REQUEST: repository preparation requires its exact workspace owner");
    }
    signal?.throwIfAborted();
    assertOwner();
    const identity = { ...input, sessionKey: input.sessionKey };
    const preparation = input.repositoryPreparation;
    if (preparation.status === "pending") {
      this.begin(identity, preparation);
    } else {
      this.settle(identity, preparation, preparation.status);
    }
    return `${preparation.status}\n`;
  }

  reset(
    input: NodeWorkerWorkspaceExecInput,
    workspaceDir: string,
    remove: () => void,
    assertOwner: () => void,
  ) {
    if (this.capture({ ...input, sessionKey: input.sessionKey ?? "" }, assertOwner)) {
      assertOwner();
      // Native model startup can own this cwd while its file/process effects remain blocked.
      for (const name of fs.readdirSync(workspaceDir)) {
        fs.rmSync(path.join(workspaceDir, name), { recursive: true, force: true });
      }
    } else {
      remove();
    }
  }

  begin(identity: Identity, repository: Repository) {
    if (this.closed) {
      throw new Error("Repository preparation owner is closed");
    }
    const previous = this.entries.get(identity.environmentId);
    if (previous) {
      if (
        previous.generation > identity.generation ||
        (previous.generation === identity.generation &&
          (previous.sessionId !== identity.sessionId ||
            previous.sessionKey !== identity.sessionKey))
      ) {
        throw new Error("INVALID_REQUEST: repository preparation epoch is stale or foreign");
      }
      if (
        previous.sessionId === identity.sessionId &&
        previous.sessionKey === identity.sessionKey &&
        previous.generation === identity.generation &&
        previous.workspaceId === repository.workspaceId &&
        previous.revision === repository.revision &&
        previous.branch === repository.branch &&
        previous.baseCommit === repository.baseCommit
      ) {
        return;
      }
      if (previous.generation === identity.generation) {
        throw new Error("INVALID_REQUEST: repository preparation cannot replace its current epoch");
      }
      previous.status = "failed";
      previous.settled.resolve();
    }
    this.entries.set(identity.environmentId, {
      ...identity,
      ...repository,
      status: "pending",
      settled: createDeferredCore(),
    });
  }

  settle(identity: Identity, repository: Repository, status: "ready" | "failed") {
    const current = this.entries.get(identity.environmentId);
    if (
      !current ||
      (status === "ready" ? current.status !== "pending" : false) ||
      current.sessionId !== identity.sessionId ||
      current.sessionKey !== identity.sessionKey ||
      current.generation !== identity.generation ||
      current.workspaceId !== repository.workspaceId ||
      current.revision !== repository.revision ||
      current.branch !== repository.branch ||
      (status === "ready" &&
        (!repository.baseCommit ||
          (current.baseCommit && current.baseCommit !== repository.baseCommit)))
    ) {
      throw new Error("INVALID_REQUEST: repository preparation owner changed");
    }
    if (status === "ready") {
      current.baseCommit = repository.baseCommit;
    }
    current.status = status;
    current.settled.resolve();
  }

  capture(identity: Identity, assertOwner: () => void) {
    const current = this.entries.get(identity.environmentId);
    if (!current) {
      return undefined;
    }
    if (
      current.sessionId !== identity.sessionId ||
      current.sessionKey !== identity.sessionKey ||
      current.generation !== identity.generation
    ) {
      throw new Error("INVALID_REQUEST: repository preparation epoch is stale or foreign");
    }
    const assertCurrent = () => {
      assertOwner();
      if (
        this.entries.get(identity.environmentId) !== current ||
        current.sessionId !== identity.sessionId ||
        current.sessionKey !== identity.sessionKey ||
        current.generation !== identity.generation ||
        current.status !== "ready"
      ) {
        throw new Error(
          current.status === "pending"
            ? "Repository preparation is pending; wait before using repository files or commands."
            : "Repository preparation failed or its worker was replaced; repository operations are blocked.",
        );
      }
    };
    return {
      assertCurrent,
      async wait(signal: AbortSignal) {
        assertOwner();
        signal.throwIfAborted();
        await racePromiseWithAbortSignal(current.settled.promise, signal);
        signal.throwIfAborted();
        assertCurrent();
      },
    };
  }

  close() {
    this.closed = true;
    for (const current of this.entries.values()) {
      current.status = "failed";
      current.settled.resolve();
    }
    this.entries.clear();
  }

  async closeProcesses(processes: { close(): Promise<void> }) {
    this.close();
    await processes.close();
  }

  async settleProcessCleanup(processes: { close(): Promise<void> }, errors: unknown[]) {
    try {
      await this.closeProcesses(processes);
    } catch (error) {
      errors.push(error);
    }
  }

  retire(environmentId: string, generation: number) {
    const current = this.entries.get(environmentId);
    if (!current || current.generation > generation) {
      return;
    }
    current.status = "failed";
    current.settled.resolve();
    this.entries.delete(environmentId);
  }
}
