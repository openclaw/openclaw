import { EnvHttpProxyAgent, getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { hasProxyEnvConfigured } from "./proxy-env.js";

function isEnvProxyDispatcher(dispatcher: unknown): boolean {
  const ctorName = (dispatcher as { constructor?: { name?: string } })?.constructor?.name;
  return typeof ctorName === "string" && ctorName.includes("EnvHttpProxyAgent");
}

export async function withEnvProxyGlobalDispatcher<T>(
  run: () => Promise<T>,
  env: NodeJS.ProcessEnv = process.env,
): Promise<T> {
  if (!hasProxyEnvConfigured(env)) {
    return await run();
  }

  let previous: unknown;
  try {
    previous = getGlobalDispatcher();
  } catch {
    return await run();
  }

  if (isEnvProxyDispatcher(previous)) {
    return await run();
  }

  try {
    setGlobalDispatcher(new EnvHttpProxyAgent());
  } catch {
    return await run();
  }

  try {
    return await run();
  } finally {
    setGlobalDispatcher(previous as Parameters<typeof setGlobalDispatcher>[0]);
  }
}
