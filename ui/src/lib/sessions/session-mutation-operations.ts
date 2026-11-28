import type { SessionConnectionOwner, SessionConnectionScope } from "./session-types.ts";

export type SessionMutationOperations = Pick<
  typeof import("./session-mutation-operations.runtime.ts"),
  | "reconcileConfirmedSessionConnection"
  | "runSessionPatch"
  | "runSessionDeferredPatch"
  | "runDeferredSessionDelete"
  | "patchSessionBatch"
  | "createSessionResult"
>;

let runtime: SessionMutationOperations | undefined;

/** Replay and settlement share this optional runtime; admission never waits for it. */
export function registerSessionMutationOperations(value: SessionMutationOperations): void {
  runtime = value;
}

export function withSessionMutationOperations<T>(
  run: (value: SessionMutationOperations) => T,
  onLoadError?: (error: unknown) => T,
) {
  return runtime
    ? run(runtime)
    : import("./session-mutation-operations.runtime.ts").then(run, onLoadError);
}

export function prepareSessionDeferredMutation(
  run: (runtime: SessionMutationOperations, scope: SessionConnectionScope) => Promise<void>,
  connection: SessionConnectionOwner,
  onDiscard?: () => void,
) {
  let discarded = false;
  const discard = () => {
    discarded = true;
    onDiscard?.();
  };
  return {
    discard,
    async run(this: void): Promise<void> {
      const scope = connection.capture();
      try {
        await withSessionMutationOperations((value) => {
          if (!scope || !connection.isCurrent(scope)) {
            discard();
            return undefined;
          }
          return discarded ? undefined : run(value, scope);
        });
      } catch (error) {
        discard();
        throw error;
      }
    },
  };
}
