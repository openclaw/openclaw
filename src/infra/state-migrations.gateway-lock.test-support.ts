import { acquireGatewayLock } from "./gateway-lock.js";

export async function withGatewayLockHeld<T>(
  env: NodeJS.ProcessEnv,
  port: number,
  run: () => Promise<T>,
): Promise<T> {
  const gatewayLock = await acquireGatewayLock({
    allowInTests: true,
    env,
    pollIntervalMs: 10,
    port,
    timeoutMs: 100,
  });
  if (!gatewayLock) {
    throw new Error("expected test Gateway lock");
  }
  try {
    return await run();
  } finally {
    await gatewayLock.release();
  }
}
