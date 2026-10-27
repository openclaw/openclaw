import fs from "node:fs/promises";
import { insideGitCheckout, runGit } from "../agents/worktrees/git.js";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db.js";
import {
  OpenClawStateLeaseError,
  type OpenClawStateLeaseContext,
  withOpenClawStateLease,
} from "../state/openclaw-state-lease.js";

const PROJECT_CHECKOUT_LEASE_MS = 30_000;
const PROJECT_CHECKOUT_WAIT_MS = 30_000;

export class ProjectCheckoutError extends Error {
  override name = "ProjectCheckoutError";
}

/** Immediate acquisition failed before the protected operation could start. */
export class ProjectCheckoutBusyError extends OpenClawStateLeaseError {
  constructor(cause: OpenClawStateLeaseError) {
    super(cause.message, { code: cause.code, cause });
  }
}

export async function withProjectCheckoutLifecycle<T>(
  repoRoot: string,
  options: OpenClawStateDatabaseOptions & { signal?: AbortSignal; waitMs?: number },
  run: (lease: OpenClawStateLeaseContext) => Promise<T>,
): Promise<T> {
  let entered = false;
  try {
    return await withOpenClawStateLease(
      {
        scope: "projects.checkout",
        key: repoRoot,
        signal: options.signal,
        database: { scope: "shared", options },
        leaseMs: PROJECT_CHECKOUT_LEASE_MS,
        waitMs: options.waitMs ?? PROJECT_CHECKOUT_WAIT_MS,
        leaseLabel: "project checkout lease",
        operationLabel: "projects.checkout.lease",
      },
      (lease) => {
        entered = true;
        return run(lease);
      },
    );
  } catch (error) {
    if (
      !entered &&
      options.waitMs === 0 &&
      error instanceof OpenClawStateLeaseError &&
      error.code === "OPENCLAW_STATE_LEASE_HELD"
    ) {
      throw new ProjectCheckoutBusyError(error);
    }
    throw error;
  }
}

export async function resolveProjectDirectory(projectPath: string): Promise<string> {
  const requested = await fs.realpath(projectPath).catch(() => {
    throw new ProjectCheckoutError(`project path does not exist: ${projectPath}`);
  });
  const stat = await fs.stat(requested).catch(() => null);
  if (!stat?.isDirectory()) {
    throw new ProjectCheckoutError(`project path is not a directory: ${projectPath}`);
  }
  return requested;
}

export async function resolveProjectCheckout(projectPath: string) {
  const requested = await resolveProjectDirectory(projectPath);
  if (!insideGitCheckout(requested)) {
    throw new ProjectCheckoutError(`project path is not a git checkout: ${projectPath}`);
  }
  const rootResult = await runGit(requested, ["rev-parse", "--show-toplevel"], {
    operation: "project.checkout",
  });
  if (rootResult.code !== 0) {
    throw new ProjectCheckoutError(`project path is not a git checkout: ${projectPath}`);
  }
  const repoRoot = await fs.realpath(rootResult.stdout.trim()).catch(() => {
    throw new ProjectCheckoutError(`project checkout root is unavailable: ${projectPath}`);
  });
  const headResult = await runGit(repoRoot, ["rev-parse", "--verify", "HEAD^{commit}"], {
    operation: "project.checkout",
  });
  if (headResult.code !== 0) {
    throw new ProjectCheckoutError(`project checkout has no commits: ${projectPath}`);
  }
  return { path: requested, repoRoot };
}
