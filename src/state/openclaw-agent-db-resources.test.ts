import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferredCore } from "../shared/deferred.js";
import {
  closeOpenClawAgentDatabaseByPath,
  closeOpenClawAgentDatabaseByPathAsync,
  closeOpenClawAgentDatabasesAsync,
  registerOpenClawAgentDatabaseAsyncResource as registerKnown,
} from "./openclaw-agent-db-lifecycle.js";
import {
  captureAgentDatabaseCloseFence,
  drainAgentDatabaseResources,
  hasOpenClawAgentDatabaseAsyncResources,
  registerOpenClawAgentDatabaseReadCandidateResource as registerCandidate,
  revokeAgentDatabaseResources,
} from "./openclaw-agent-db-resources.js";
import {
  createOpenClawDatabaseMaintenanceScope,
  observeOpenClawDatabaseMaintenanceResource,
} from "./openclaw-state-db-async-lifecycle.js";

const root = path.join(os.tmpdir(), `agent-resource-lifecycle-${process.pid}`);

function resource(filename: string, close: () => Promise<void> = async () => {}) {
  return {
    agentId: "worker",
    path: path.join(root, filename),
    revoke: vi.fn(),
    close: vi.fn(close),
  };
}

afterEach(async () => {
  await closeOpenClawAgentDatabasesAsync(root);
});

it("promotes a shared registration beyond its creating maintenance scope", async () => {
  const parent = createOpenClawDatabaseMaintenanceScope();
  const child = parent.run(() => createOpenClawDatabaseMaintenanceScope());
  const held = resource("shared-maintenance.sqlite");
  const unregister = child.run(() => registerCandidate(held));
  parent.run(() => observeOpenClawDatabaseMaintenanceResource(unregister));
  try {
    await child.close();
    expect(held.revoke).not.toHaveBeenCalled();
    expect(hasOpenClawAgentDatabaseAsyncResources()).toBe(true);
    await parent.close();
    expect(held.close).toHaveBeenCalledOnce();
    expect(hasOpenClawAgentDatabaseAsyncResources()).toBe(false);
  } finally {
    await parent.close();
    unregister();
  }
});

it.each(["known", "unresolved"] as const)(
  "joins exact %s retirement without retiring another owner",
  async (ownership) => {
    const gate = createDeferredCore();
    const held = resource("worker.sqlite", () => gate.promise);
    const sibling = { ...resource("kept.sqlite"), agentId: "kept" };
    const register = ownership === "known" ? registerKnown : registerCandidate;
    const release = register(held);
    register(sibling);
    if (ownership === "known") {
      expect(closeOpenClawAgentDatabaseByPath(held.path, "kept")).toBe(false);
      expect(held.revoke).not.toHaveBeenCalled();
      expect(closeOpenClawAgentDatabaseByPath(held.path, "worker")).toBe(false);
      expect(held.revoke).toHaveBeenCalledOnce();
    }
    let settled = false;
    const closing = closeOpenClawAgentDatabaseByPathAsync(
      held.path,
      ownership === "known" ? "worker" : "discovered-later",
    ).then(() => {
      settled = true;
    });
    try {
      if (ownership === "unresolved") {
        expect(held.revoke).toHaveBeenCalledOnce();
        release();
      }
      await Promise.resolve();
      expect(settled).toBe(false);
      expect(held.close).toHaveBeenCalledOnce();
      expect(sibling.revoke).not.toHaveBeenCalled();
      expect(() =>
        registerKnown({ ...held, agentId: ownership === "known" ? "worker" : "other" }),
      ).toThrow("are closing");
    } finally {
      gate.resolve();
      await closing;
    }
    expect(settled).toBe(true);
  },
);

it.each(["known-directory", "unresolved-directory", "unresolved-member"] as const)(
  "limits %s drainage to the selected root",
  async (selection) => {
    const gate = createDeferredCore();
    const candidate = {
      ...resource("selected/nested/candidate.sqlite", () => gate.promise),
      scope: "sibling-family" as const,
    };
    const sibling = {
      ...resource("selected-sibling/candidate.sqlite"),
      scope: "sibling-family" as const,
    };
    const register = selection === "known-directory" ? registerKnown : registerCandidate;
    register(candidate);
    register(sibling);
    const rootPath = path.join(
      root,
      selection === "unresolved-member" ? "selected/nested/candidate.worker.sqlite" : "selected",
    );
    const closing = closeOpenClawAgentDatabasesAsync(rootPath);
    try {
      expect(candidate.revoke).toHaveBeenCalledOnce();
      expect(sibling.revoke).not.toHaveBeenCalled();
      if (selection === "known-directory") {
        expect(() => registerKnown(resource("selected/new.sqlite"))).toThrow("are closing");
      }
    } finally {
      gate.resolve();
      await closing;
    }
    expect(candidate.close).toHaveBeenCalledOnce();
  },
);

it.each([false, true])(
  "keeps a draining root fenced through every settlement (failure: %s)",
  async (fail) => {
    let failClose = fail;
    const gate = createDeferredCore();
    const held = {
      agentId: "worker",
      path: path.join(root, "selected", "worker.sqlite"),
      revoke: vi.fn(() => {
        expect(() =>
          registerKnown({
            agentId: "reentrant",
            path: path.join(root, "selected", "reentrant.sqlite"),
            revoke() {},
            close: async () => {},
          }),
        ).toThrow("are closing");
      }),
      close: () => gate.promise,
    };
    const sibling = {
      agentId: "kept",
      path: path.join(root, "sibling", "kept.sqlite"),
      revoke: vi.fn(),
      close: async () => {},
    };
    registerKnown(held);
    registerKnown(sibling);
    const failure = new Error("independent resource close failed");
    const failureObserved = createDeferredCore();
    const failedPath = path.join(root, "selected", "failed.sqlite");
    if (fail) {
      registerKnown({
        agentId: "failed",
        path: failedPath,
        revoke() {},
        async close() {
          failureObserved.resolve();
          if (failClose) {
            throw failure;
          }
        },
      });
    }
    let settled = false;
    const closing = closeOpenClawAgentDatabasesAsync(path.join(root, "selected")).then(
      () => {
        settled = true;
      },
      (error: unknown) => {
        settled = true;
        throw error;
      },
    );
    void closing.catch(() => {});
    try {
      if (fail) {
        await failureObserved.promise;
      }
      expect(settled).toBe(false);
      expect(held.revoke).toHaveBeenCalledOnce();
      expect(sibling.revoke).not.toHaveBeenCalled();
      expect(() =>
        registerKnown({
          ...held,
          path: path.join(root, "selected", "new.sqlite"),
        }),
      ).toThrow("are closing");
    } finally {
      gate.resolve();
      if (fail) {
        await expect(closing).rejects.toThrow("Agent database");
        failClose = false;
        await closeOpenClawAgentDatabaseByPathAsync(failedPath);
      } else {
        await closing;
      }
    }
  },
);

it.each(["known", "unresolved", "maintenance"] as const)(
  "retains failed %s custody after unregistering until retry succeeds",
  async (owner) => {
    const scope = createOpenClawDatabaseMaintenanceScope();
    let fail = true;
    const failure = new Error("native close unsettled");
    const held = resource("retry.sqlite", async () => {
      if (fail) {
        throw failure;
      }
    });
    const register = owner === "known" ? registerKnown : registerCandidate;
    const unregister = owner === "maintenance" ? scope.run(() => register(held)) : register(held);
    const close = () =>
      owner === "maintenance"
        ? scope.close()
        : closeOpenClawAgentDatabaseByPathAsync(held.path, "worker");
    try {
      const closing = close();
      if (owner === "maintenance") {
        await expect(closing).rejects.toBe(failure);
      } else {
        const fence = captureAgentDatabaseCloseFence(held);
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
      }
      unregister();
      expect(hasOpenClawAgentDatabaseAsyncResources()).toBe(true);
      expect(() => registerKnown(held)).toThrow("are closing");
      expect(() => registerCandidate(held)).toThrow("are closing");
      if (owner !== "known") {
        expect(() => registerKnown({ ...held, agentId: "other" })).toThrow("are closing");
      }
    } finally {
      fail = false;
      if (owner === "maintenance") {
        await scope.close();
      } else {
        await closeOpenClawAgentDatabaseByPathAsync(held.path);
      }
    }
    expect(held.close).toHaveBeenCalledTimes(2);
    expect(hasOpenClawAgentDatabaseAsyncResources()).toBe(false);
    registerKnown(held)();
    registerCandidate(held)();
  },
);

it("reports a shared maintenance close failure to an ordinary close waiter", async () => {
  const scope = createOpenClawDatabaseMaintenanceScope();
  const gate = createDeferredCore();
  const failure = new Error("shared maintenance failure");
  const onCloseError = vi.fn();
  let fail = true;
  const held = resource("maintenance-observer.sqlite", () =>
    fail ? gate.promise : Promise.resolve(),
  );
  scope.run(() => registerCandidate(held));
  const closing = scope.close();
  const observed = Promise.allSettled(
    revokeAgentDatabaseResources({ path: held.path }, onCloseError),
  );
  try {
    gate.reject(failure);
    await expect(closing).rejects.toBe(failure);
    expect(await observed).toEqual([{ status: "rejected", reason: failure }]);
    expect(onCloseError).toHaveBeenCalledExactlyOnceWith(held.path, failure);
  } finally {
    fail = false;
    await scope.close();
  }
});

it.each(["ordinary", "maintenance"])(
  "retains unresolved custody before a %s reentrant revoke callback",
  async (owner) => {
    const scope = createOpenClawDatabaseMaintenanceScope();
    let unexpectedRelease: (() => void) | undefined;
    let admissionError: unknown;
    const held = resource("reentrant.sqlite");
    const register = () =>
      registerCandidate({
        ...held,
        revoke() {
          try {
            unexpectedRelease = registerKnown({ ...held, agentId: "different-owner" });
          } catch (error) {
            admissionError = error;
          }
        },
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
        await closeOpenClawAgentDatabaseByPathAsync(held.path, "worker");
      }
      expect(admissionError).toBeInstanceOf(Error);
      expect(unexpectedRelease).toBeUndefined();
    } finally {
      unexpectedRelease?.();
    }
  },
);

it("does not retain candidates refused by a closed inherited maintenance scope", async () => {
  const scope = createOpenClawDatabaseMaintenanceScope();
  const gate = createDeferredCore();
  const held = resource("late-maintenance.sqlite");
  const delayed = scope.run(() => ({ promise: gate.promise.then(() => registerCandidate(held)) }));
  await scope.close();
  gate.resolve();
  await expect(delayed.promise).rejects.toThrow("maintenance resource scope is closed");
  expect(hasOpenClawAgentDatabaseAsyncResources()).toBe(false);
  expect(held.close).not.toHaveBeenCalled();
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
    const held = {
      ...resource("candidate.sqlite"),
      scope: family ? ("sibling-family" as const) : undefined,
    };
    const closing = drainAgentDatabaseResources(selection, async () => {
      entered.resolve();
      await gate.promise;
    });
    const target = { agentId: "worker", path: selection.path ?? held.path };
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
      expect(() => registerCandidate(held)).toThrow("are closing");
      expect(held.revoke).not.toHaveBeenCalled();
    } finally {
      gate.resolve();
      await closing;
      await fence;
      await otherPathFence;
    }
    expect(captureAgentDatabaseCloseFence(target)).toBeUndefined();
    registerCandidate(held)();
  },
);

it.each(["complete", "native-failure"] as const)(
  "captures full close completion through %s without following a successor",
  async (ending) => {
    const resourceGate = createDeferredCore();
    const nativeGate = createDeferredCore();
    const nativeEntered = createDeferredCore();
    const failure = new Error("native close failed");
    const held = resource("captured-close.sqlite", () => resourceGate.promise);
    expect(captureAgentDatabaseCloseFence(held)).toBeUndefined();
    registerKnown(held);
    const closeNative = vi.fn(async () => {
      nativeEntered.resolve();
      await nativeGate.promise;
      if (ending === "native-failure") {
        throw failure;
      }
      return "closed";
    });
    const selection = { agentId: held.agentId, path: held.path };
    const closing = drainAgentDatabaseResources(selection, closeNative);
    const fence = captureAgentDatabaseCloseFence(held);
    const outcomes = Promise.allSettled([closing, fence]);
    let fenceSettled = false;
    const settled = () => {
      fenceSettled = true;
    };
    void fence?.then(settled, settled);
    try {
      expect(fence).toBeDefined();
      expect(held.revoke).toHaveBeenCalledOnce();
      await Promise.resolve();
      expect(held.close).toHaveBeenCalledOnce();
      expect(closeNative).not.toHaveBeenCalled();
      resourceGate.resolve();
      await nativeEntered.promise;
      expect(fenceSettled).toBe(false);
      expect(() => registerKnown(held)).toThrow("are closing");
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
    expect(captureAgentDatabaseCloseFence(held)).toBeUndefined();
    const successor = resource("captured-close.sqlite");
    registerKnown(successor);
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
  { released: true, family: false },
  { released: false, family: true },
])(
  "retains the known owner through handoff (candidate released=$released, family=$family)",
  async ({ released, family }) => {
    const gate = createDeferredCore();
    const candidate = {
      ...resource("shared.sqlite", () => gate.promise),
      scope: family ? ("sibling-family" as const) : undefined,
    };
    const known = {
      ...resource(family ? "shared.owner.2.sqlite" : "shared.sqlite", () => gate.promise),
      agentId: "resolved",
    };
    const unrelated = [
      resource("shared-other.sqlite"),
      resource("shared.owner.sqlite-wal"),
      resource("sibling/shared.owner.sqlite"),
    ];
    const release = registerCandidate(candidate);
    registerKnown(known);
    for (const sibling of unrelated) {
      registerCandidate(sibling);
    }
    if (released) {
      release();
      await closeOpenClawAgentDatabaseByPathAsync(known.path, "unrelated");
      expect(known.revoke).not.toHaveBeenCalled();
    }
    expect(hasOpenClawAgentDatabaseAsyncResources()).toBe(true);
    const closing = closeOpenClawAgentDatabaseByPathAsync(known.path, "resolved");
    try {
      expect(candidate.revoke).toHaveBeenCalledTimes(released ? 0 : 1);
      expect(known.revoke).toHaveBeenCalledOnce();
      for (const sibling of unrelated) {
        expect(sibling.revoke).not.toHaveBeenCalled();
      }
      if (family) {
        expect(() =>
          registerKnown({
            ...known,
            path: path.join(root, "shared.new-owner.sqlite"),
            agentId: "new-owner",
          }),
        ).toThrow("are closing");
        registerKnown(resource("other/shared.owner.2.sqlite"))();
        for (const sibling of unrelated) {
          registerCandidate(sibling)();
        }
      }
    } finally {
      gate.resolve();
      await closing;
    }
    expect(known.close).toHaveBeenCalledOnce();
    expect(candidate.close).toHaveBeenCalledTimes(released ? 0 : 1);
    for (const sibling of unrelated) {
      expect(sibling.close).not.toHaveBeenCalled();
      await closeOpenClawAgentDatabaseByPathAsync(sibling.path);
    }
    expect(hasOpenClawAgentDatabaseAsyncResources()).toBe(false);
    release();
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
    const candidate = {
      ...resource(held, async () => {
        if (fail) {
          throw new Error("family close unsettled");
        }
      }),
      scope: "sibling-family" as const,
    };
    const release = heldFamily
      ? registerCandidate(candidate)
      : registerKnown({ ...candidate, agentId: "held" });
    const incomingResource = { ...candidate, path: path.join(root, incoming), agentId: "new" };
    const registerIncoming = () =>
      incomingFamily ? registerCandidate(incomingResource) : registerKnown(incomingResource);
    try {
      await expect(closeOpenClawAgentDatabaseByPathAsync(candidate.path, "held")).rejects.toThrow(
        "resource drainage failed",
      );
      release();
      expect(registerIncoming).toThrow("are closing");
    } finally {
      fail = false;
      await closeOpenClawAgentDatabaseByPathAsync(candidate.path, "held");
    }
    registerIncoming()();
  },
);
