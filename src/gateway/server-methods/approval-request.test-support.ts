import { vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { GatewayRequestContext, GatewayRequestHandler } from "./types.js";

/** Observe the RPC event, including calls made before observation was installed. */
export async function waitForApprovalRequested(
  broadcast: GatewayRequestContext["broadcast"],
  eventName: string,
  request: ReturnType<GatewayRequestHandler>,
): Promise<void> {
  const mock = vi.mocked(broadcast);
  const observed = createDeferred();
  const implementation = mock.getMockImplementation();
  mock.mockImplementation((...args) => {
    implementation?.(...args);
    if (args[0] === eventName) {
      observed.resolve();
    }
  });
  try {
    if (mock.mock.calls.some(([event]) => event === eventName)) {
      observed.resolve();
    }
    await Promise.race([
      observed.promise,
      Promise.resolve(request).then(() => {
        throw new Error("Approval request completed before the expected RPC event");
      }),
    ]);
  } finally {
    mock.mockImplementation(implementation ?? (() => {}));
  }
}
