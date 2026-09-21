import { vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";

/** Observe the approval event, including calls made before observation was installed. */
export async function waitForApprovalRequested<TArgs extends [string, ...unknown[]]>(
  broadcast: (...args: TArgs) => void,
  eventName: string,
  request: Promise<unknown> | void,
  matchesRequest: (payload: TArgs[1]) => boolean = () => true,
): Promise<void> {
  const mock = vi.mocked(broadcast);
  const observed = createDeferred();
  const implementation = mock.getMockImplementation();
  const matches = (args: TArgs) => args[0] === eventName && matchesRequest(args[1]);
  mock.mockImplementation((...args) => {
    implementation?.(...args);
    if (matches(args)) {
      observed.resolve();
    }
  });
  try {
    if (mock.mock.calls.some(matches)) {
      observed.resolve();
    }
    await Promise.race([
      observed.promise,
      Promise.resolve(request).then(() => {
        throw new Error("Approval request completed before the expected approval event");
      }),
    ]);
  } finally {
    mock.mockImplementation(implementation ?? (() => {}));
  }
}
