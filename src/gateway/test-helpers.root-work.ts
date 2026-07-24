/**
 * Gateway root-work admission helpers shared by streaming HTTP tests.
 */
import { getActiveGatewayRootWorkCount } from "../process/gateway-work-admission.js";

/**
 * Holds mocked agent work until the streaming HTTP handler has returned.
 * SSE headers reach the client before the handler unwinds, so one extra
 * macrotask turn guarantees the request's root-work lease was released.
 */
export function createPostHandlerGate() {
  let open = () => {};
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return {
    opened,
    openAfterHandlerReturned: async () => {
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      open();
    },
  };
}

export async function waitForRootWorkCount(expected: number): Promise<number> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const active = getActiveGatewayRootWorkCount();
    if (active === expected) {
      return active;
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 5);
    });
  }
  return getActiveGatewayRootWorkCount();
}
