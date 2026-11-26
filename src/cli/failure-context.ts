import { AsyncLocalStorage } from "node:async_hooks";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";

const failureContext = resolveGlobalSingleton(
  Symbol.for("openclaw.cliFailureContext"),
  () => new AsyncLocalStorage<{ argv?: string[] }>(),
);

export const getCliFailureContext = () => failureContext.getStore();

export async function withCliFailureContext<T>(run: () => Promise<T>): Promise<T> {
  const context: { argv?: string[] } = {};
  try {
    return await failureContext.run(context, run);
  } finally {
    // A detached callback can outlive this command. Its errors belong to the
    // host process once command cleanup ends; do not retain former arguments.
    context.argv = undefined;
  }
}
