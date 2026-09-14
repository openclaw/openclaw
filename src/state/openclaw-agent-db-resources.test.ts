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
import {
  hasOpenClawAgentDatabaseAsyncResources,
  registerUnresolvedOpenClawAgentDatabaseAsyncResource,
  drainAgentDatabaseResources,
} from "./openclaw-agent-db-resources.js";

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

it.each(["custom.sqlite", "custom.worker.sqlite", "custom.worker.2.sqlite"])(
  "retains retirement during unresolved target discovery for %s",
  async (name) => {
    const gate = createDeferredCore();
    const pathname = path.join(root, name);
    const revoke = vi.fn();
    const registration = registerUnresolvedOpenClawAgentDatabaseAsyncResource(
      {
        agentId: "worker",
        paths: [path.join(root, "custom.sqlite"), path.join(root, "custom.worker.sqlite")],
        numberedPath: path.join(root, "custom.worker.sqlite"),
      },
      { revoke, close: () => gate.promise },
    );
    const closing = closeOpenClawAgentDatabaseByPathAsync(pathname, "worker");
    try {
      expect(revoke).toHaveBeenCalledOnce();
      expect(() => registration.bind({ agentId: "worker", path: pathname })).toThrow("are closing");
    } finally {
      gate.resolve();
      await closing;
      registration.unregister();
    }
    // Completing retirement must not revive the request that was already revoked.
    expect(() => registration.bind({ agentId: "worker", path: pathname })).toThrow("are closing");
  },
);

it("narrows discovery custody to its bound owner without canceling sibling stores", async () => {
  const first = path.join(root, "custom.sqlite");
  const chosen = path.join(root, "custom.worker.3.sqlite");
  const revoke = vi.fn();
  const registration = registerUnresolvedOpenClawAgentDatabaseAsyncResource(
    {
      agentId: "worker",
      paths: [first, path.join(root, "custom.worker.sqlite")],
      numberedPath: path.join(root, "custom.worker.sqlite"),
    },
    { revoke, close: async () => {} },
  );
  try {
    await closeOpenClawAgentDatabaseByPathAsync(path.join(root, "custom.other.3.sqlite"), "other");
    expect(revoke).not.toHaveBeenCalled();
    expect(() =>
      registration.bind({ agentId: "worker", path: path.join(root, "other.sqlite") }),
    ).toThrow("outside");
    registration.bind({ agentId: "worker", path: chosen });
    await closeOpenClawAgentDatabaseByPathAsync(first, "worker");
    expect(revoke).not.toHaveBeenCalled();
    await closeOpenClawAgentDatabaseByPathAsync(chosen, "worker");
    expect(revoke).toHaveBeenCalledOnce();
  } finally {
    registration.unregister();
  }
});

it("retains agent-only retirement until an exact shared store's physical owner is known", async () => {
  const registration = registerUnresolvedOpenClawAgentDatabaseAsyncResource(
    { paths: [path.join(root, "shared.sqlite")] },
    { revoke: () => {}, close: async () => {} },
  );
  try {
    await drainAgentDatabaseResources({ agentId: "physical-owner" }, async () => {});
    expect(() =>
      registration.bind({ agentId: "physical-owner", path: path.join(root, "shared.sqlite") }),
    ).toThrow("are closing");
  } finally {
    registration.unregister();
  }
});

it.each([
  { supplied: "", owner: "main" },
  { supplied: " Worker ", owner: "worker" },
])(
  "normalizes exact resource ownership before matching retirement ($owner)",
  async ({ supplied, owner }) => {
    const pathname = path.join(root, "normalized.sqlite");
    const revoke = vi.fn();
    const unregister = registerOpenClawAgentDatabaseAsyncResource({
      agentId: supplied,
      path: pathname,
      revoke,
      close: async () => {},
    });
    try {
      await closeOpenClawAgentDatabaseByPathAsync(pathname, owner);
      expect(revoke).toHaveBeenCalledOnce();
    } finally {
      unregister();
    }
  },
);
