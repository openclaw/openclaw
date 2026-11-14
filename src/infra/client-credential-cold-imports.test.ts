import { expect, it, vi } from "vitest";

// mock-isolation: These unused runtimes must not be evaluated by credential entry imports.
vi.mock("./gateway-state-owner.js", () => {
  throw new Error("eager local credential authority");
});
vi.mock("./worker-task-pool.js", () => {
  throw new Error("eager credential worker pool");
});
vi.mock("./client-credential-ipc.js", () => {
  throw new Error("eager credential IPC");
});
vi.mock("./client-credential-store.js", () => {
  throw new Error("eager synchronous credential store");
});

it("loads the async credential entry without optional local or app runtimes", async () => {
  const entry = await import("./client-credential-async.js");
  expect(entry.runClientCredentialOperationAsync).toBeTypeOf("function");
});

it("loads async device identity without the synchronous credential store", async () => {
  const entry = await import("./device-identity-async.js");
  expect(entry.loadDeviceIdentityIfPresentAsync).toBeTypeOf("function");
});
