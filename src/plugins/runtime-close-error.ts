import { collectNestedErrorCandidates } from "@openclaw/normalization-core/error-coercion";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";

/** Host cleanup that is safe to repeat after partial release. */
export type PluginCleanupRecovery = {
  isReleased(): boolean;
  recover(): void | Promise<void>;
};

// The singleton constructor shares in-flight recovery across runtime module copies.
const recoveryAttempts = new WeakMap<PluginCleanupRecovery, Promise<void>>();

class RetainedRuntimeError extends Error {
  readonly errors: unknown[] = [];

  constructor(
    cause: unknown,
    private readonly recovery?: PluginCleanupRecovery,
  ) {
    super("Plugin runtime cleanup failed; outstanding resource custody must settle before close.", {
      cause,
    });
    this.name = "PluginRuntimeCloseRetainedError";
  }

  get recoverable(): boolean {
    return this.recovery !== undefined;
  }

  /** Check release state without starting cleanup. */
  get retained(): boolean {
    if (this.recovery && recoveryAttempts.has(this.recovery)) {
      return true;
    }
    try {
      return !this.recovery?.isReleased();
    } catch {
      return true;
    }
  }

  /** Join concurrent recovery attempts for the same resource. */
  recover(): Promise<void> {
    const existing = this.recovery && recoveryAttempts.get(this.recovery);
    if (existing) {
      return existing;
    }
    if (!this.recovery || !this.retained) {
      return Promise.resolve();
    }
    const recovery = this.recovery;
    const pending = Promise.resolve()
      .then(() => recovery.recover())
      .catch((error: unknown) => {
        if (!this.errors.includes(error)) {
          this.errors.push(error);
        }
      });
    recoveryAttempts.set(recovery, pending);
    void pending.then(() => {
      recoveryAttempts.delete(recovery);
    });
    return pending;
  }
}

// Source Gateway owners and compiled SDK claims share cleanup custody and error identity.
export const PluginRuntimeCloseRetainedError: typeof RetainedRuntimeError = resolveGlobalSingleton(
  Symbol.for("openclaw.pluginRuntimeCloseRetainedError"),
  () => RetainedRuntimeError,
);

export type PluginRuntimeCloseRetainedError = InstanceType<typeof PluginRuntimeCloseRetainedError>;

/** The resource owner finished cleanup and returned callback failures for observation. */
export const PluginRuntimeCloseCompletedError = resolveGlobalSingleton(
  Symbol.for("openclaw.pluginRuntimeCloseCompletedError"),
  () => class CompletedRuntimeError extends AggregateError {},
);

export function aggregatePluginRuntimeCloseErrors(
  failures: readonly unknown[],
  message: string,
): AggregateError {
  return failures.length > 0 &&
    failures.every((failure) => failure instanceof PluginRuntimeCloseCompletedError)
    ? new PluginRuntimeCloseCompletedError(failures, message)
    : new AggregateError(failures, message);
}

/** Check for unreleased resources without discarding past cleanup errors. */
export function hasRetainedPluginRuntimeCloseError(error: unknown): boolean {
  return collectNestedErrorCandidates(error).some(
    (candidate) => candidate instanceof PluginRuntimeCloseRetainedError && candidate.retained,
  );
}

/** Recover resources through their host-provided cleanup handles. */
export async function recoverPluginRuntimeCloseError(error: unknown): Promise<void> {
  const owners = new Set(
    collectNestedErrorCandidates(error).filter(
      (candidate): candidate is PluginRuntimeCloseRetainedError =>
        candidate instanceof PluginRuntimeCloseRetainedError,
    ),
  );
  await Promise.all([...owners].map((owner) => owner.recover()));
}

/** Dispose once; later calls retry only recoverable host cleanup. */
export function createRecoverablePluginRelease<T>(dispose: () => Promise<T>): () => Promise<T> {
  let completion: Promise<T> | undefined;
  let failure: { error: unknown } | undefined;
  const observe = async (error: unknown): Promise<never> => {
    await recoverPluginRuntimeCloseError(error);
    if (
      collectNestedErrorCandidates(error).some(
        (candidate) =>
          candidate instanceof PluginRuntimeCloseRetainedError &&
          candidate.recoverable &&
          candidate.retained,
      )
    ) {
      failure = { error };
    }
    throw error;
  };
  return () => {
    if (failure) {
      const { error } = failure;
      failure = undefined;
      completion = observe(error);
    }
    return (completion ??= Promise.resolve().then(dispose).catch(observe));
  };
}
