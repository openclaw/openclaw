import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferredCore } from "../shared/deferred.js";
import {
  closeOpenClawAgentDatabaseByPath,
  closeOpenClawAgentDatabaseByPathAsync,
  closeOpenClawAgentDatabasesAsync,
  registerOpenClawAgentDatabaseAsyncResource,
} from "./openclaw-agent-db-lifecycle.js";
import { hasOpenClawAgentDatabaseAsyncResources } from "./openclaw-agent-db-resources.js";

const root = path.join(os.tmpdir(), `agent-resource-lifecycle-${process.pid}`);

afterEach(async () => {
  await closeOpenClawAgentDatabasesAsync(root);
});

it("revokes only the exact owner synchronously and joins its native retirement", async () => {
  const gate = createDeferredCore();
  const resource = {
    agentId: "worker",
    path: path.join(root, "worker.sqlite"),
    revoke: vi.fn(),
    close: vi.fn(() => gate.promise),
  };
  const sibling = {
    agentId: "kept",
    path: path.join(root, "kept.sqlite"),
    revoke: vi.fn(),
    close: vi.fn(async () => {}),
  };
  registerOpenClawAgentDatabaseAsyncResource(resource);
  registerOpenClawAgentDatabaseAsyncResource(sibling);
  expect(closeOpenClawAgentDatabaseByPath(resource.path, "kept")).toBe(false);
  expect(resource.revoke).not.toHaveBeenCalled();
  expect(closeOpenClawAgentDatabaseByPath(resource.path, "worker")).toBe(false);
  expect(resource.revoke).toHaveBeenCalledOnce();
  let closed = false;
  const closing = closeOpenClawAgentDatabaseByPathAsync(resource.path, "worker").then(() => {
    closed = true;
  });
  try {
    await Promise.resolve();
    expect(closed).toBe(false);
    expect(resource.close).toHaveBeenCalledOnce();
    expect(sibling.revoke).not.toHaveBeenCalled();
    expect(() => registerOpenClawAgentDatabaseAsyncResource(resource)).toThrow("are closing");
  } finally {
    gate.resolve();
    await closing;
  }
  expect(closed).toBe(true);
});

it("blocks new resources in a draining root without retiring a sibling root", async () => {
  const gate = createDeferredCore();
  const resource = {
    agentId: "worker",
    path: path.join(root, "selected", "worker.sqlite"),
    revoke: vi.fn(),
    close: () => gate.promise,
  };
  const sibling = {
    agentId: "kept",
    path: path.join(root, "sibling", "kept.sqlite"),
    revoke: vi.fn(),
    close: async () => {},
  };
  registerOpenClawAgentDatabaseAsyncResource(resource);
  registerOpenClawAgentDatabaseAsyncResource(sibling);
  const closing = closeOpenClawAgentDatabasesAsync(path.join(root, "selected"));
  try {
    expect(resource.revoke).toHaveBeenCalledOnce();
    expect(sibling.revoke).not.toHaveBeenCalled();
    expect(() =>
      registerOpenClawAgentDatabaseAsyncResource({
        ...resource,
        path: path.join(root, "selected", "new.sqlite"),
      }),
    ).toThrow("are closing");
  } finally {
    gate.resolve();
    await closing;
  }
});

it("retains a failed close after unregistering and retries it before readmission", async () => {
  let fail = true;
  const resource = {
    agentId: "worker",
    path: path.join(root, "retry.sqlite"),
    revoke: vi.fn(),
    close: vi.fn(async () => {
      if (fail) {
        throw new Error("native close unsettled");
      }
    }),
  };
  const unregister = registerOpenClawAgentDatabaseAsyncResource(resource);
  try {
    await expect(closeOpenClawAgentDatabaseByPathAsync(resource.path)).rejects.toThrow(
      "resource drainage failed",
    );
    unregister();
    expect(hasOpenClawAgentDatabaseAsyncResources()).toBe(true);
    expect(() => registerOpenClawAgentDatabaseAsyncResource(resource)).toThrow("are closing");
  } finally {
    fail = false;
    await closeOpenClawAgentDatabaseByPathAsync(resource.path);
  }
  expect(resource.close).toHaveBeenCalledTimes(2);
  expect(hasOpenClawAgentDatabaseAsyncResources()).toBe(false);
  registerOpenClawAgentDatabaseAsyncResource(resource)();
});
