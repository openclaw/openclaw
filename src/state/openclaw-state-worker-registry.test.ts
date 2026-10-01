import { expect, it, vi } from "vitest";
import type { WorkerOperationContext } from "./worker-operation-registry.js";

const { loaded, read } = vi.hoisted(() => ({
  loaded: [] as string[],
  read: vi.fn((nodeId: string, context: WorkerOperationContext) => ({
    nodeId,
    path: context.stateOptions().path,
  })),
}));

vi.mock("../infra/push-apns-store.worker.js", () => {
  loaded.push("apns");
  return { apnsOperations: { "apns.registration.read": read } };
});
vi.mock("../infra/push-web-store.worker.js", () => {
  throw new Error("APNs preparation loaded Web Push");
});
vi.mock("../agents/worktrees/dispatch.worker.js", () => {
  throw new Error("APNs preparation loaded worktrees");
});
vi.mock("../fleet/registry.worker.js", () => {
  throw new Error("APNs preparation loaded fleet");
});

import { stateWorkerRegistry } from "./openclaw-state-worker-registry.js";

it("loads only the requested domain and routes exact operation names after preparation", async () => {
  const context: WorkerOperationContext = {
    open: () => {
      throw new Error("The registry must leave database opening to its handler");
    },
    stateOptions: () => ({ path: "synthetic-state.sqlite", env: {} }),
  };
  const command = { type: "apns.registration.read", input: "synthetic-node" } as const;
  expect(loaded).toEqual([]);
  expect(stateWorkerRegistry.prepare("cron.loadMutable")).toBeUndefined();
  expect(loaded).toEqual([]);
  await Promise.all([
    stateWorkerRegistry.prepare(command.type),
    stateWorkerRegistry.prepare(command.type),
  ]);
  expect(loaded).toEqual(["apns"]);
  expect(stateWorkerRegistry.prepare(command.type)).toBeUndefined();
  expect(stateWorkerRegistry.has(command)).toBe(true);
  expect(stateWorkerRegistry.has({ type: "apns.registration.missing", input: undefined })).toBe(
    false,
  );
  expect(stateWorkerRegistry.has({ type: "apns.toString", input: undefined })).toBe(false);
  expect(stateWorkerRegistry.execute(command, context)).toEqual({
    nodeId: "synthetic-node",
    path: "synthetic-state.sqlite",
  });
  expect(read).toHaveBeenCalledExactlyOnceWith(command.input, context);
});
