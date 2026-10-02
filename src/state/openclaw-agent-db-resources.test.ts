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
  captureAgentDatabaseCloseFence,
  drainAgentDatabaseResources,
  hasOpenClawAgentDatabaseAsyncResources,
  matchesAgentDatabaseReadCandidatePath,
  registerOpenClawAgentDatabaseReadCandidateResource,
  revokeAgentDatabaseResources,
} from "./openclaw-agent-db-resources.js";
import {
  createOpenClawDatabaseMaintenanceScope,
  observeOpenClawDatabaseMaintenanceResource,
} from "./openclaw-state-db-async-lifecycle.js";

const root = path.join(os.tmpdir(), `agent-resource-lifecycle-${process.pid}`);

afterEach(async () => {
  await closeOpenClawAgentDatabasesAsync(root);
});

it.each(["known", "unresolved"] as const)(
  "promotes a shared %s registration beyond its creating maintenance scope",
  async (ownership) => {
    const parent = createOpenClawDatabaseMaintenanceScope();
    const child = parent.run(() => createOpenClawDatabaseMaintenanceScope());
    const resource = {
      agentId: "shared",
      path: path.join(root, "shared-maintenance.sqlite"),
      revoke: vi.fn(),
      close: vi.fn(async () => {}),
    };
    const register =
      ownership === "known"
        ? registerOpenClawAgentDatabaseAsyncResource
        : registerOpenClawAgentDatabaseReadCandidateResource;
    const unregister = child.run(() => register(resource));
    parent.run(() => observeOpenClawDatabaseMaintenanceResource(unregister));
    try {
      await child.close();
      expect(resource.revoke).not.toHaveBeenCalled();
      expect(hasOpenClawAgentDatabaseAsyncResources()).toBe(true);
      await parent.close();
      expect(resource.close).toHaveBeenCalledOnce();
      expect(hasOpenClawAgentDatabaseAsyncResources()).toBe(false);
    } finally {
      await parent.close();
      unregister();
    }
  },
);

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

it.each(["known", "unresolved"] as const)(
  "retains a failed %s close after unregistering and retries it before readmission",
  async (ownership) => {
    let fail = true;
    const failure = new Error("native close unsettled");
    const resource = {
      agentId: "worker",
      path: path.join(root, "retry.sqlite"),
      revoke: vi.fn(),
      close: vi.fn(async () => {
        if (fail) {
          throw failure;
        }
      }),
    };
    const register =
      ownership === "known"
        ? registerOpenClawAgentDatabaseAsyncResource
        : registerOpenClawAgentDatabaseReadCandidateResource;
    const unregister = register(resource);
    try {
      const closing = closeOpenClawAgentDatabaseByPathAsync(resource.path, "worker");
      const fence = captureAgentDatabaseCloseFence(resource);
      expect(fence).toBeDefined();
      const [result, observed] = await Promise.allSettled([closing, fence]);
      expect(result).toMatchObject({
        status: "rejected",
        reason: { message: "Agent database resource drainage failed", errors: [failure] },
      });
      expect(observed.status).toBe("rejected");
      if (result.status === "rejected" && observed.status === "rejected") {
        expect(observed.reason).toBe(result.reason);
      }
      unregister();
      expect(hasOpenClawAgentDatabaseAsyncResources()).toBe(true);
      expect(() => registerOpenClawAgentDatabaseAsyncResource(resource)).toThrow("are closing");
      expect(() => registerOpenClawAgentDatabaseReadCandidateResource(resource)).toThrow(
        "are closing",
      );
      if (ownership === "unresolved") {
        expect(() =>
          registerOpenClawAgentDatabaseAsyncResource({ ...resource, agentId: "other" }),
        ).toThrow("are closing");
      }
    } finally {
      fail = false;
      await closeOpenClawAgentDatabaseByPathAsync(resource.path);
    }
    expect(resource.close).toHaveBeenCalledTimes(2);
    expect(hasOpenClawAgentDatabaseAsyncResources()).toBe(false);
    registerOpenClawAgentDatabaseAsyncResource(resource)();
    registerOpenClawAgentDatabaseReadCandidateResource(resource)();
  },
);

it("joins an unresolved read on an agent-specific close without closing another path", async () => {
  const gate = createDeferredCore();
  const candidate = {
    path: path.join(root, "unresolved.sqlite"),
    revoke: vi.fn(),
    close: vi.fn(() => gate.promise),
  };
  const sibling = {
    path: path.join(root, "sibling.sqlite"),
    revoke: vi.fn(),
    close: vi.fn(async () => {}),
  };
  const release = registerOpenClawAgentDatabaseReadCandidateResource(candidate);
  registerOpenClawAgentDatabaseReadCandidateResource(sibling);
  const closing = closeOpenClawAgentDatabaseByPathAsync(candidate.path, "discovered-later");
  let settled = false;
  void closing.then(() => {
    settled = true;
  });
  try {
    expect(candidate.revoke).toHaveBeenCalledOnce();
    release();
    await Promise.resolve();
    expect(candidate.close).toHaveBeenCalledOnce();
    expect(settled).toBe(false);
    expect(sibling.revoke).not.toHaveBeenCalled();
    expect(() =>
      registerOpenClawAgentDatabaseAsyncResource({ ...candidate, agentId: "other" }),
    ).toThrow("are closing");
  } finally {
    gate.resolve();
    await closing;
  }
  expect(settled).toBe(true);
});

it.each(["directory", "member"])(
  "limits unresolved root drainage to the selected %s",
  async (selected) => {
    const selectedRoot = path.join(root, "selected");
    const candidate = {
      path: path.join(selectedRoot, "nested", "candidate.sqlite"),
      scope: "sibling-family" as const,
      revoke: vi.fn(),
      close: vi.fn(async () => {}),
    };
    const sibling = {
      path: path.join(root, "selected-sibling", "candidate.sqlite"),
      scope: "sibling-family" as const,
      revoke: vi.fn(),
      close: vi.fn(async () => {}),
    };
    registerOpenClawAgentDatabaseReadCandidateResource(candidate);
    registerOpenClawAgentDatabaseReadCandidateResource(sibling);
    const rootPath =
      selected === "directory"
        ? selectedRoot
        : path.join(selectedRoot, "nested", "candidate.worker.sqlite");
    await closeOpenClawAgentDatabasesAsync(rootPath);
    expect(candidate.close).toHaveBeenCalledOnce();
    expect(sibling.revoke).not.toHaveBeenCalled();
  },
);

it("reports a shared maintenance close failure to an ordinary close waiter", async () => {
  const scope = createOpenClawDatabaseMaintenanceScope();
  const gate = createDeferredCore();
  const failure = new Error("shared maintenance failure");
  const onCloseError = vi.fn();
  let fail = true;
  const pathname = path.join(root, "maintenance-observer.sqlite");
  scope.run(() =>
    registerOpenClawAgentDatabaseReadCandidateResource({
      path: pathname,
      revoke() {},
      close: () => (fail ? gate.promise : Promise.resolve()),
    }),
  );
  const closing = scope.close();
  const observed = Promise.allSettled(
    revokeAgentDatabaseResources({ path: pathname }, onCloseError),
  );
  try {
    gate.reject(failure);
    await expect(closing).rejects.toBe(failure);
    expect(await observed).toEqual([{ status: "rejected", reason: failure }]);
    expect(onCloseError).toHaveBeenCalledExactlyOnceWith(pathname, failure);
  } finally {
    fail = false;
    await scope.close();
  }
});

it.each(["ordinary", "maintenance"])(
  "retains unresolved custody before a %s reentrant revoke callback",
  async (owner) => {
    const pathname = path.join(root, "reentrant.sqlite");
    const scope = createOpenClawDatabaseMaintenanceScope();
    let unexpectedRelease: (() => void) | undefined;
    let admissionError: unknown;
    const register = () =>
      registerOpenClawAgentDatabaseReadCandidateResource({
        path: pathname,
        revoke() {
          try {
            unexpectedRelease = registerOpenClawAgentDatabaseAsyncResource({
              agentId: "different-owner",
              path: pathname,
              revoke() {},
              close: async () => {},
            });
          } catch (error) {
            admissionError = error;
          }
        },
        close: async () => {},
      });
    if (owner === "maintenance") {
      scope.run(register);
    } else {
      register();
    }
    try {
      if (owner === "maintenance") {
        await scope.close();
      } else {
        await closeOpenClawAgentDatabaseByPathAsync(pathname, "worker");
      }
      expect(admissionError).toBeInstanceOf(Error);
      expect(unexpectedRelease).toBeUndefined();
    } finally {
      unexpectedRelease?.();
    }
  },
);

it("retains failed maintenance close custody after the candidate unregisters", async () => {
  const scope = createOpenClawDatabaseMaintenanceScope();
  let fail = true;
  const candidate = {
    path: path.join(root, "maintenance-retry.sqlite"),
    revoke: vi.fn(),
    close: vi.fn(async () => {
      if (fail) {
        throw new Error("maintenance close unsettled");
      }
    }),
  };
  const release = scope.run(() => registerOpenClawAgentDatabaseReadCandidateResource(candidate));
  try {
    await expect(scope.close()).rejects.toThrow("maintenance close unsettled");
    release();
    expect(hasOpenClawAgentDatabaseAsyncResources()).toBe(true);
    expect(() =>
      registerOpenClawAgentDatabaseAsyncResource({ ...candidate, agentId: "resolved" }),
    ).toThrow("are closing");
  } finally {
    fail = false;
    await scope.close();
  }
  expect(candidate.close).toHaveBeenCalledTimes(2);
  expect(hasOpenClawAgentDatabaseAsyncResources()).toBe(false);
});

it("does not retain candidates refused by a closed inherited maintenance scope", async () => {
  const scope = createOpenClawDatabaseMaintenanceScope();
  const gate = createDeferredCore();
  const candidate = {
    path: path.join(root, "late-maintenance.sqlite"),
    revoke: vi.fn(),
    close: vi.fn(async () => {}),
  };
  // The detached callback inherits the scope but is not admitted maintenance work.
  const delayed = scope.run(() => ({
    promise: gate.promise.then(() => registerOpenClawAgentDatabaseReadCandidateResource(candidate)),
  }));
  await scope.close();
  gate.resolve();
  await expect(delayed.promise).rejects.toThrow("maintenance resource scope is closed");
  expect(hasOpenClawAgentDatabaseAsyncResources()).toBe(false);
  expect(candidate.close).not.toHaveBeenCalled();
});

it.each([
  {
    label: "path and agent",
    family: false,
    selection: { path: path.join(root, "candidate.sqlite"), agentId: "worker" },
  },
  { label: "root and agent", family: false, selection: { rootPath: root, agentId: "worker" } },
  { label: "agent", family: false, selection: { agentId: "worker" } },
  {
    label: "family member and agent",
    family: true,
    selection: { path: path.join(root, "candidate.late.sqlite"), agentId: "worker" },
  },
])(
  "refuses unresolved admission throughout a $label close selection",
  async ({ selection, family }) => {
    const gate = createDeferredCore();
    const entered = createDeferredCore();
    const candidate = {
      path: path.join(root, "candidate.sqlite"),
      scope: family ? ("sibling-family" as const) : undefined,
      revoke: vi.fn(),
      close: async () => {},
    };
    const closing = drainAgentDatabaseResources(selection, async () => {
      entered.resolve();
      await gate.promise;
    });
    const target = { agentId: "worker", path: selection.path ?? candidate.path };
    const fence = captureAgentDatabaseCloseFence({
      ...target,
      agentId: "WORKER",
      path: path.relative(process.cwd(), target.path),
    });
    const otherPathFence = captureAgentDatabaseCloseFence({
      ...target,
      path: path.join(`${root}-sibling`, "candidate.sqlite"),
    });
    try {
      expect(fence).toBeDefined();
      expect(captureAgentDatabaseCloseFence({ ...target, agentId: "other" })).toBeUndefined();
      if (selection.path || "rootPath" in selection) {
        expect(otherPathFence).toBeUndefined();
      } else {
        expect(otherPathFence).toBeDefined();
      }
      await entered.promise;
      expect(() => registerOpenClawAgentDatabaseReadCandidateResource(candidate)).toThrow(
        "are closing",
      );
      expect(candidate.revoke).not.toHaveBeenCalled();
    } finally {
      gate.resolve();
      await closing;
      await fence;
      await otherPathFence;
    }
    expect(captureAgentDatabaseCloseFence(target)).toBeUndefined();
    registerOpenClawAgentDatabaseReadCandidateResource(candidate)();
  },
);

it.each(["complete", "native-failure"] as const)(
  "captures full close completion through %s without following a successor",
  async (ending) => {
    const resourceGate = createDeferredCore();
    const nativeGate = createDeferredCore();
    const nativeEntered = createDeferredCore();
    const failure = new Error("native close failed");
    const resource = {
      agentId: "worker",
      path: path.join(root, "captured-close.sqlite"),
      revoke: vi.fn(),
      close: vi.fn(() => resourceGate.promise),
    };
    expect(captureAgentDatabaseCloseFence(resource)).toBeUndefined();
    registerOpenClawAgentDatabaseAsyncResource(resource);
    const closeNative = vi.fn(async () => {
      nativeEntered.resolve();
      await nativeGate.promise;
      if (ending === "native-failure") {
        throw failure;
      }
      return "closed";
    });
    const selection = { agentId: resource.agentId, path: resource.path };
    const closing = drainAgentDatabaseResources(selection, closeNative);
    const fence = captureAgentDatabaseCloseFence(resource);
    const outcomes = Promise.allSettled([closing, fence]);
    let fenceSettled = false;
    void fence?.then(
      () => {
        fenceSettled = true;
      },
      () => {
        fenceSettled = true;
      },
    );
    try {
      expect(fence).toBeDefined();
      expect(resource.revoke).toHaveBeenCalledOnce();
      await Promise.resolve();
      expect(resource.close).toHaveBeenCalledOnce();
      expect(closeNative).not.toHaveBeenCalled();
      resourceGate.resolve();
      await nativeEntered.promise;
      expect(fenceSettled).toBe(false);
      expect(() => registerOpenClawAgentDatabaseAsyncResource(resource)).toThrow("are closing");
    } finally {
      resourceGate.resolve();
      nativeGate.resolve();
      await outcomes;
    }
    expect(await outcomes).toEqual(
      ending === "complete"
        ? [
            { status: "fulfilled", value: "closed" },
            { status: "fulfilled", value: undefined },
          ]
        : [
            { status: "rejected", reason: failure },
            { status: "rejected", reason: failure },
          ],
    );
    if (ending === "native-failure") {
      await expect(fence).rejects.toBe(failure);
    }
    expect(captureAgentDatabaseCloseFence(resource)).toBeUndefined();
    const successor = { ...resource, revoke: vi.fn(), close: vi.fn(async () => {}) };
    registerOpenClawAgentDatabaseAsyncResource(successor);
    await outcomes;
    expect(successor.revoke).not.toHaveBeenCalled();
    expect(successor.close).not.toHaveBeenCalled();
    const successorGate = createDeferredCore();
    let successorClosed = false;
    const successorClosing = drainAgentDatabaseResources(selection, async () => {
      await successorGate.promise;
      successorClosed = true;
    });
    try {
      await Promise.allSettled([fence]);
      expect(successorClosed).toBe(false);
    } finally {
      successorGate.resolve();
      await successorClosing;
    }
  },
);

it.each([
  { released: false, family: false },
  { released: true, family: false },
  { released: false, family: true },
  { released: true, family: true },
])(
  "retains the known owner through handoff (candidate released=$released, family=$family)",
  async ({ released, family }) => {
    const candidate = {
      path: path.join(root, "handoff.sqlite"),
      scope: family ? ("sibling-family" as const) : undefined,
      revoke: vi.fn(),
      close: vi.fn(async () => {}),
    };
    const known = {
      ...candidate,
      path: path.join(root, family ? "handoff.owner.2.sqlite" : "handoff.sqlite"),
      agentId: "resolved",
      revoke: vi.fn(),
      close: vi.fn(async () => {}),
    };
    const release = registerOpenClawAgentDatabaseReadCandidateResource(candidate);
    registerOpenClawAgentDatabaseAsyncResource(known);
    if (released) {
      release();
      await closeOpenClawAgentDatabaseByPathAsync(known.path, "unrelated");
      expect(known.revoke).not.toHaveBeenCalled();
    }
    expect(hasOpenClawAgentDatabaseAsyncResources()).toBe(true);
    await closeOpenClawAgentDatabaseByPathAsync(known.path, "resolved");
    expect(known.close).toHaveBeenCalledOnce();
    expect(candidate.close).toHaveBeenCalledTimes(released ? 0 : 1);
    expect(hasOpenClawAgentDatabaseAsyncResources()).toBe(false);
    release();
  },
);

it.each([
  { filename: "shared.sqlite", matches: true },
  { filename: "shared.owner.2.sqlite", matches: true },
  { filename: "shared..sqlite", matches: true },
  { filename: "shared-other.sqlite", matches: false },
  { filename: "shared.owner.sqlite-wal", matches: false },
  { filename: "sibling/shared.owner.sqlite", matches: false },
])("checks captured read membership for $filename", ({ filename, matches }) => {
  const candidate = { path: path.join(root, "shared.sqlite"), scope: "sibling-family" as const };
  expect(matchesAgentDatabaseReadCandidatePath(candidate, path.join(root, filename))).toBe(matches);
  expect(
    matchesAgentDatabaseReadCandidatePath({ path: candidate.path }, path.join(root, filename)),
  ).toBe(filename === "shared.sqlite");
});

it.each(["shared.late.sqlite", "shared.owner.2.sqlite", "shared..sqlite"])(
  "retains discovery of a later sibling %s through close",
  async (filename) => {
    const gate = createDeferredCore();
    const candidate = {
      path: path.join(root, "shared.sqlite"),
      scope: "sibling-family" as const,
      revoke: vi.fn(),
      close: () => gate.promise,
    };
    const known = {
      path: path.join(root, filename),
      agentId: "discovered",
      revoke: vi.fn(),
      close: vi.fn(async () => {}),
    };
    const unrelated = {
      ...candidate,
      path: path.join(root, "shared-other.sqlite"),
      revoke: vi.fn(),
      close: async () => {},
    };
    registerOpenClawAgentDatabaseReadCandidateResource(candidate);
    registerOpenClawAgentDatabaseReadCandidateResource(unrelated);
    registerOpenClawAgentDatabaseAsyncResource(known);
    const closing = closeOpenClawAgentDatabaseByPathAsync(known.path, known.agentId);
    try {
      expect(candidate.revoke).toHaveBeenCalledOnce();
      expect(known.revoke).toHaveBeenCalledOnce();
      expect(unrelated.revoke).not.toHaveBeenCalled();
      expect(() =>
        registerOpenClawAgentDatabaseAsyncResource({
          ...known,
          path: path.join(root, "shared.new-owner.sqlite"),
          agentId: "new-owner",
        }),
      ).toThrow("are closing");
      registerOpenClawAgentDatabaseAsyncResource({
        ...known,
        path: path.join(root, "other", filename),
      })();
      registerOpenClawAgentDatabaseReadCandidateResource(unrelated)();
    } finally {
      gate.resolve();
      await closing;
    }
  },
);

it.each([
  {
    held: "shared.sqlite",
    heldFamily: true,
    incoming: "shared.child.sqlite",
    incomingFamily: true,
  },
  {
    held: "shared.child.sqlite",
    heldFamily: true,
    incoming: "shared.sqlite",
    incomingFamily: true,
  },
  {
    held: "shared.child.sqlite",
    heldFamily: false,
    incoming: "shared.sqlite",
    incomingFamily: true,
  },
  { held: "shared.sqlite", heldFamily: true, incoming: "shared.new.sqlite", incomingFamily: false },
])(
  "retains failed sibling custody from $held to $incoming (family=$heldFamily/$incomingFamily)",
  async ({ held, heldFamily, incoming, incomingFamily }) => {
    let fail = true;
    const resource = {
      path: path.join(root, held),
      scope: "sibling-family" as const,
      revoke: vi.fn(),
      close: vi.fn(async () => {
        if (fail) {
          throw new Error("family close unsettled");
        }
      }),
    };
    const release = heldFamily
      ? registerOpenClawAgentDatabaseReadCandidateResource(resource)
      : registerOpenClawAgentDatabaseAsyncResource({ ...resource, agentId: "held" });
    const registerIncoming = () =>
      incomingFamily
        ? registerOpenClawAgentDatabaseReadCandidateResource({
            ...resource,
            path: path.join(root, incoming),
          })
        : registerOpenClawAgentDatabaseAsyncResource({
            ...resource,
            path: path.join(root, incoming),
            agentId: "new",
          });
    try {
      await expect(closeOpenClawAgentDatabaseByPathAsync(resource.path, "held")).rejects.toThrow(
        "resource drainage failed",
      );
      release();
      expect(registerIncoming).toThrow("are closing");
    } finally {
      fail = false;
      await closeOpenClawAgentDatabaseByPathAsync(resource.path, "held");
    }
    registerIncoming()();
  },
);
