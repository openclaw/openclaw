import { AsyncLocalStorage } from "node:async_hooks";
import type { ProcessEventMap } from "node:process";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";

type FailureEvent = "uncaughtException" | "unhandledRejection";
type FailureHandler = (reason: unknown) => void;
type FailureContext = Partial<Record<FailureEvent, FailureHandler>> & { argv?: string[] };
type Invocation = { active?: FailureContext };

const failureContext = resolveGlobalSingleton(
  Symbol.for("openclaw.cliFailureContext"),
  () => new AsyncLocalStorage<Invocation>(),
);

export const getCliFailureContext = () => failureContext.getStore()?.active;

export function installProcessFailureListener(event: FailureEvent, handle: FailureHandler) {
  const registration = resolveGlobalSingleton(
    Symbol.for(`openclaw.processFailureListener.${event}`),
    () => {
      const owner = {
        handle,
        listener: (...[reason]: ProcessEventMap[FailureEvent]): void => {
          (getCliFailureContext()?.[event] ?? owner.handle)(reason);
        },
      };
      return owner;
    },
  );
  // Each module load has its own exit barriers. A live command uses its reporter.
  // After cleanup, the last installed reporter owns the process's exit.
  registration.handle = handle;
  const context = getCliFailureContext();
  if (context) {
    context[event] = handle;
  }
  if (!process.listeners(event).includes(registration.listener)) {
    process.on(event, registration.listener);
  }
  return registration.listener;
}

export async function withCliFailureContext<T>(run: () => Promise<T>): Promise<T> {
  const invocation: Invocation = { active: {} };
  try {
    return await failureContext.run(invocation, run);
  } finally {
    // Detached callbacks may outlive cleanup. Release both argv and its reporters.
    invocation.active = undefined;
  }
}
