import { expect, it, vi } from "vitest";
import {
  createWorkerOperationRegistry,
  type WorkerOperationContext,
  type WorkerWriteOperationContext,
} from "./worker-operation-registry.js";

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

import { stateWorkerRegistry } from "./openclaw-state-worker-registry.js";

it("loads only the requested domain and routes exact operation names after preparation", async () => {
  const context: WorkerWriteOperationContext = {
    open: () => {
      throw new Error("The registry must leave database opening to its handler");
    },
    write: () => {
      throw new Error("The registry must leave transactions to its handler");
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

it("prepares exact operations without loading another kernel under the same namespace", async () => {
  type Operations = {
    "session.read": { input: string; output: string };
    "session.write": { input: string; output: void };
  };
  const loadRead = vi.fn(async () => ({
    "session.read": (input: string, context: { agentId: string }) => `${context.agentId}:${input}`,
  }));
  const loadWrite = vi.fn(async () => ({ "session.write": (_input: string) => {} }));
  const registry = createWorkerOperationRegistry<Operations, { agentId: string }, keyof Operations>(
    {
      "session.read": loadRead,
      "session.write": loadWrite,
    },
  );
  const command = { type: "session.read", input: "entry" } as const;
  expect(() => registry.execute(command, { agentId: "agent" })).toThrow("not prepared");
  await Promise.all([registry.prepare(command.type), registry.prepare(command.type)]);
  expect(registry.execute(command, { agentId: "agent" })).toBe("agent:entry");
  expect(loadRead).toHaveBeenCalledOnce();
  expect(loadWrite).not.toHaveBeenCalled();
  expect(registry.has({ type: "session.write", input: "entry" })).toBe(false);
});
