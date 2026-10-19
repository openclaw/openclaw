import os from "node:os";
import path from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";
import { settleSqliteTestAgentCloses } from "../../test/sqlite-test-lifecycle.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  closeOpenClawAgentDatabaseByPath as closePath,
  closeOpenClawAgentDatabaseByPathAsync as closePathAsync,
  closeOpenClawAgentDatabasesAsync as closeDatabases,
  registerOpenClawAgentDatabaseAsyncResource as registerKnown,
} from "./openclaw-agent-db-lifecycle.js";
import {
  isAgentDatabaseClosing as isClosing,
  drainAgentDatabaseResources as drainResources,
  hasOpenClawAgentDatabaseAsyncResources as hasResources,
  registerOpenClawAgentDatabaseReadCandidateResource as registerCandidate,
  revokeAgentDatabaseResources as revokeResources,
} from "./openclaw-agent-db-resources.js";
import {
  createOpenClawDatabaseMaintenanceScope as createScope,
  observeOpenClawDatabaseMaintenanceResource as observeResource,
} from "./openclaw-state-db-async-lifecycle.js";

const root = path.join(os.tmpdir(), `agent-resource-lifecycle-${process.pid}`);

function resource(
  filename: string,
  close: () => Promise<void> = async () => {},
  options: { agentId?: string; scope?: "sibling-family"; revoke?: () => void } = {},
) {
  const { revoke, ...overrides } = options;
  return {
    agentId: "worker",
    path: path.join(root, filename),
    revoke: vi.fn(revoke),
    close: vi.fn(close),
    ...overrides,
  };
}

async function duringClose(
  closing: Promise<unknown>,
  gate: ReturnType<typeof createDeferredCore<void>>,
  check: () => void | Promise<void>,
) {
  try {
    await check();
  } finally {
    gate.resolve();
    await closing;
  }
}

function expectClosing(register: () => unknown) {
  expect(register).toThrow("are closing");
}

function expectCalls(count: number, ...mocks: Array<{ mock: { calls: unknown[][] } }>) {
  for (const mock of mocks) {
    expect(mock.mock.calls).toHaveLength(count);
  }
}

function failingResource(filename: string, message: string, onClose?: () => void) {
  const failure = new Error(message);
  let failed = true;
  return {
    ...resource(filename, async () => {
      onClose?.();
      if (failed) {
        throw failure;
      }
    }),
    failure,
    recover() {
      failed = false;
    },
  };
}

function trackSettlement(promise: Promise<unknown>) {
  const tracked = {
    settled: false,
    promise: promise.finally(() => {
      tracked.settled = true;
    }),
  };
  void tracked.promise.catch(() => {});
  return tracked;
}

afterEach(async () => {
  await closeDatabases(root);
});

it("promotes a shared registration beyond its creating maintenance scope", async () => {
  const parent = createScope();
  const child = parent.run(() => createScope());
  const held = resource("shared-maintenance.sqlite");
  const unregister = child.run(() => registerCandidate(held));
  parent.run(() => observeResource(unregister));
  try {
    await child.close();
    expect(held.revoke).not.toHaveBeenCalled();
    expect(hasResources()).toBe(true);
    await parent.close();
    expect(held.close).toHaveBeenCalledOnce();
    expect(hasResources()).toBe(false);
  } finally {
    await parent.close();
    unregister();
  }
});

it.each([
  "known",
  "unresolved",
  "known-directory",
  "unresolved-directory",
  "unresolved-member",
] as const)("joins %s retirement without retiring another owner", async (selection) => {
  const exact = selection === "known" || selection === "unresolved";
  const gate = createDeferredCore();
  const scope = exact ? undefined : "sibling-family";
  const held = resource("selected/nested/candidate.sqlite", () => gate.promise, { scope });
  const sibling = resource("selected-sibling/candidate.sqlite", undefined, {
    scope,
    agentId: "kept",
  });
  const register = selection.startsWith("known") ? registerKnown : registerCandidate;
  const release = register(held);
  register(sibling);
  if (selection === "known") {
    expect(closePath(held.path, "kept")).toBe(false);
    expect(held.revoke).not.toHaveBeenCalled();
    expect(closePath(held.path, "worker")).toBe(false);
    expect(held.revoke).toHaveBeenCalledOnce();
  }
  const tracked = trackSettlement(
    exact
      ? closePathAsync(held.path, selection === "known" ? "worker" : "discovered-later")
      : closeDatabases(
          path.join(
            root,
            selection === "unresolved-member"
              ? "selected/nested/candidate.worker.sqlite"
              : "selected",
          ),
        ),
  );
  await duringClose(tracked.promise, gate, async () => {
    if (selection !== "known") {
      expect(held.revoke).toHaveBeenCalledOnce();
    }
    if (selection === "unresolved") {
      release();
    }
    await Promise.resolve();
    expect(tracked.settled).toBe(false);
    expect(held.close).toHaveBeenCalledOnce();
    expect(sibling.revoke).not.toHaveBeenCalled();
    if (exact) {
      expectClosing(() =>
        registerKnown({ ...held, agentId: selection === "known" ? "worker" : "other" }),
      );
    } else if (selection === "known-directory") {
      expectClosing(() => registerKnown(resource("selected/new.sqlite")));
    }
  });
  expect(tracked.settled).toBe(true);
  expect(held.close).toHaveBeenCalledOnce();
});

it.each([false, true])(
  "keeps a draining root fenced through every settlement (failure: %s)",
  async (fail) => {
    const gate = createDeferredCore();
    const held = resource("selected/worker.sqlite", () => gate.promise, {
      revoke: () =>
        expectClosing(() =>
          registerKnown(resource("selected/reentrant.sqlite", undefined, { agentId: "reentrant" })),
        ),
    });
    const sibling = resource("sibling/kept.sqlite", undefined, { agentId: "kept" });
    registerKnown(held);
    registerKnown(sibling);
    const failureObserved = createDeferredCore();
    const failed = failingResource(
      "selected/failed.sqlite",
      "independent resource close failed",
      () => failureObserved.resolve(),
    );
    if (fail) {
      registerKnown({ ...failed, agentId: "failed" });
    }
    const tracked = trackSettlement(closeDatabases(path.join(root, "selected")));
    try {
      if (fail) {
        await failureObserved.promise;
      }
      expect(tracked.settled).toBe(false);
      expect(held.revoke).toHaveBeenCalledOnce();
      expect(sibling.revoke).not.toHaveBeenCalled();
      expectClosing(() => registerKnown({ ...held, path: path.join(root, "selected/new.sqlite") }));
    } finally {
      gate.resolve();
      if (fail) {
        await expect(tracked.promise).rejects.toThrow("Agent database");
        failed.recover();
        await closePathAsync(failed.path);
      } else {
        await tracked.promise;
      }
    }
  },
);

it.each([
  ["known", "retry.sqlite", false, "", false],
  ["unresolved", "retry.sqlite", false, "", false],
  ["maintenance", "retry.sqlite", false, "", false],
  ["unresolved", "shared.sqlite", true, "shared.child.sqlite", true],
  ["unresolved", "shared.child.sqlite", true, "shared.sqlite", true],
  ["known", "shared.child.sqlite", true, "shared.sqlite", true],
  ["unresolved", "shared.sqlite", true, "shared.new.sqlite", false],
] as const)(
  "retains failed %s custody of %s (family=%s, incoming=%s, incoming family=%s)",
  async (owner, filename, family, incoming, incomingFamily) => {
    const scope = createScope();
    const held = {
      ...failingResource(filename, "native close unsettled"),
      scope: family ? ("sibling-family" as const) : undefined,
    };
    const { failure } = held;
    const register = owner === "known" ? registerKnown : registerCandidate;
    const unregister = owner === "maintenance" ? scope.run(() => register(held)) : register(held);
    const close = () =>
      owner === "maintenance" ? scope.close() : closePathAsync(held.path, "worker");
    const incomingResource = { ...held, path: path.join(root, incoming), agentId: "new" };
    const registerIncoming = () =>
      incomingFamily ? registerCandidate(incomingResource) : registerKnown(incomingResource);
    try {
      const closing = close();
      if (owner === "maintenance") {
        await expect(closing).rejects.toBe(failure);
      } else {
        expect(isClosing(held)).toBe(true);
        await expect(closing).rejects.toMatchObject({
          message: "Agent database resource drainage failed",
          errors: [failure],
        });
      }
      unregister();
      expect(hasResources()).toBe(true);
      expectClosing(() => registerKnown(held));
      expectClosing(() => registerCandidate(held));
      if (owner !== "known") {
        expectClosing(() => registerKnown({ ...held, agentId: "other" }));
      }
      if (incoming) {
        expectClosing(registerIncoming);
      }
    } finally {
      held.recover();
      if (owner === "maintenance") {
        await scope.close();
      } else {
        await closePathAsync(held.path);
      }
    }
    expect(held.close).toHaveBeenCalledTimes(2);
    expect(hasResources()).toBe(false);
    registerKnown(held)();
    registerCandidate(held)();
    if (incoming) {
      registerIncoming()();
    }
  },
);

it("reports a shared maintenance close failure to an ordinary close waiter", async () => {
  const scope = createScope();
  const gate = createDeferredCore();
  const failure = new Error("shared maintenance failure");
  const onCloseError = vi.fn();
  let fail = true;
  const held = resource("maintenance-observer.sqlite", () =>
    fail ? gate.promise : Promise.resolve(),
  );
  scope.run(() => registerCandidate(held));
  const closing = scope.close();
  const observed = Promise.allSettled(revokeResources({ path: held.path }, onCloseError));
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
    const scope = createScope();
    let unexpectedRelease: (() => void) | undefined;
    const held = resource("reentrant.sqlite");
    const revoke = vi.fn(() =>
      expectClosing(() => {
        unexpectedRelease = registerKnown({ ...held, agentId: "different-owner" });
      }),
    );
    const register = () => registerCandidate({ ...held, revoke });
    if (owner === "maintenance") {
      scope.run(register);
    } else {
      register();
    }
    try {
      if (owner === "maintenance") {
        await scope.close();
      } else {
        await closePathAsync(held.path, "worker");
      }
      expect(revoke).toHaveBeenCalled();
      expect(unexpectedRelease).toBeUndefined();
    } finally {
      unexpectedRelease?.();
    }
  },
);

it("does not retain candidates refused by a closed inherited maintenance scope", async () => {
  const scope = createScope();
  const gate = createDeferredCore();
  const held = resource("late-maintenance.sqlite");
  const delayed = scope.run(() => ({ promise: gate.promise.then(() => registerCandidate(held)) }));
  await scope.close();
  gate.resolve();
  await expect(delayed.promise).rejects.toThrow("maintenance resource scope is closed");
  expect(hasResources()).toBe(false);
  expect(held.close).not.toHaveBeenCalled();
});

it.each([
  ["path and agent", false, { path: path.join(root, "candidate.sqlite"), agentId: "worker" }],
  ["root and agent", false, { rootPath: root, agentId: "worker" }],
  ["agent", false, { agentId: "worker" }],
  ["family and agent", true, { path: path.join(root, "candidate.late.sqlite"), agentId: "worker" }],
] as const)(
  "refuses unresolved admission throughout %s close",
  async (_label, family, selection) => {
    const gate = createDeferredCore();
    const entered = createDeferredCore();
    const held = resource("candidate.sqlite", undefined, {
      scope: family ? "sibling-family" : undefined,
    });
    const closing = drainResources(selection, async () => {
      entered.resolve();
      await gate.promise;
    });
    const target = { agentId: "worker", path: "path" in selection ? selection.path : held.path };
    const closingTarget = isClosing({
      ...target,
      agentId: "WORKER",
      path: path.relative(process.cwd(), target.path),
    });
    const closingOtherPath = isClosing({
      ...target,
      path: path.join(`${root}-sibling`, "candidate.sqlite"),
    });
    await duringClose(closing, gate, async () => {
      expect(closingTarget).toBe(true);
      expect(isClosing({ ...target, agentId: "other" })).toBe(false);
      if ("path" in selection || "rootPath" in selection) {
        expect(closingOtherPath).toBe(false);
      } else {
        expect(closingOtherPath).toBe(true);
      }
      await entered.promise;
      expectClosing(() => registerCandidate(held));
      expect(held.revoke).not.toHaveBeenCalled();
    });
    expect(isClosing(target)).toBe(false);
    registerCandidate(held)();
  },
);

it.each(["complete", "native-failure"] as const)(
  "drains resources before native %s and restores admission",
  async (ending) => {
    const resourceGate = createDeferredCore();
    const nativeGate = createDeferredCore();
    const nativeEntered = createDeferredCore();
    const failure = new Error("native close failed");
    const held = resource("captured-close.sqlite", () => resourceGate.promise);
    expect(isClosing(held)).toBe(false);
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
    const closing = drainResources(selection, closeNative);
    const outcomes = Promise.allSettled([closing]);
    let observing: ReturnType<typeof trackSettlement> | undefined;
    try {
      expect(isClosing(held)).toBe(true);
      expect(held.revoke).toHaveBeenCalledOnce();
      await Promise.resolve();
      expect(held.close).toHaveBeenCalledOnce();
      expect(closeNative).not.toHaveBeenCalled();
      resourceGate.resolve();
      await nativeEntered.promise;
      expect(isClosing(held)).toBe(true);
      expectClosing(() => registerKnown(held));
      observing = trackSettlement(settleSqliteTestAgentCloses());
      await nextTurn();
      expect(observing.settled).toBe(false);
    } finally {
      resourceGate.resolve();
      nativeGate.resolve();
      await outcomes;
      await observing?.promise;
    }
    expect(await outcomes).toEqual(
      ending === "complete"
        ? [{ status: "fulfilled", value: "closed" }]
        : [{ status: "rejected", reason: failure }],
    );
    expect(isClosing(held)).toBe(false);
    expect(observing?.settled).toBe(true);
    const successor = resource("captured-close.sqlite");
    registerKnown(successor);
    await outcomes;
    expectCalls(0, successor.revoke, successor.close);
  },
);

it.each([
  { released: true, family: false },
  { released: false, family: true },
])(
  "retains the known owner through handoff (candidate released=$released, family=$family)",
  async ({ released, family }) => {
    const gate = createDeferredCore();
    const candidate = resource("shared.sqlite", () => gate.promise, {
      scope: family ? "sibling-family" : undefined,
    });
    const known = resource(family ? "shared.owner.2.sqlite" : "shared.sqlite", () => gate.promise, {
      agentId: "resolved",
    });
    const unrelated = [
      "shared-other.sqlite",
      "shared.owner.sqlite-wal",
      "sibling/shared.owner.sqlite",
    ].map((name) => resource(name));
    const release = registerCandidate(candidate);
    registerKnown(known);
    for (const sibling of unrelated) {
      registerCandidate(sibling);
    }
    if (released) {
      release();
      await closePathAsync(known.path, "unrelated");
      expect(known.revoke).not.toHaveBeenCalled();
    }
    expect(hasResources()).toBe(true);
    const closing = closePathAsync(known.path, "resolved");
    await duringClose(closing, gate, () => {
      expect(candidate.revoke).toHaveBeenCalledTimes(released ? 0 : 1);
      expect(known.revoke).toHaveBeenCalledOnce();
      expectCalls(0, ...unrelated.map((sibling) => sibling.revoke));
      if (family) {
        expectClosing(() =>
          registerKnown(resource("shared.new-owner.sqlite", undefined, { agentId: "new-owner" })),
        );
        registerKnown(resource("other/shared.owner.2.sqlite"))();
        for (const sibling of unrelated) {
          registerCandidate(sibling)();
        }
      }
    });
    expect(known.close).toHaveBeenCalledOnce();
    expect(candidate.close).toHaveBeenCalledTimes(released ? 0 : 1);
    for (const sibling of unrelated) {
      expect(sibling.close).not.toHaveBeenCalled();
      await closePathAsync(sibling.path);
    }
    expect(hasResources()).toBe(false);
    release();
  },
);
