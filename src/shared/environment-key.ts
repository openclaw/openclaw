import { resolveGlobalSingleton } from "./global-singleton.js";

const processEnvironment = resolveGlobalSingleton(
  Symbol.for("openclaw.processEnvironmentKey"),
  () => ({ key: {}, aliases: new WeakSet<object>([process.env]) }),
);

/** Ambient environment scopes survive replacement of the process.env object. */
export function resolveEnvironmentKey(env?: NodeJS.ProcessEnv): object {
  if (env === undefined || env === process.env) {
    return processEnvironment.key;
  }
  return processEnvironment.aliases.has(env) ? processEnvironment.key : env;
}

/** Remember ambient references when binding facts so retained callers keep their scope. */
export function captureEnvironmentKey(env: NodeJS.ProcessEnv = process.env): object {
  const key = resolveEnvironmentKey(env);
  if (key === processEnvironment.key) {
    processEnvironment.aliases.add(env);
  }
  return key;
}
