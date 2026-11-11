import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { expect, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../../test/helpers/promise.js";
import { requireGit } from "../../agents/worktrees/git.js";
import { withWorktreePreparationTiming } from "../../agents/worktrees/preparation-timing.js";
import * as diagnostics from "../../infra/diagnostic-events.js";
import { closeOpenClawStateDatabaseAsync } from "../../state/openclaw-state-db.js";
import { prepareSandboxCheckpointFixture } from "./local-workspace-incremental.test-support.js";
import { withLocalWorkspaceProjection } from "./local-workspace-projection.js";
import { readLocalWorkspaceProjection } from "./local-workspace-store.test-support.js";
import type { LocalWorkspaceOwner } from "./local-workspace-types.js";

const writeText = (directory: string, relative: string, data: string) =>
  fs.writeFile(path.join(directory, relative), data);
const expectText = async (directory: string, relative: string, expected: string) =>
  expect(await fs.readFile(path.join(directory, relative), "utf8")).toBe(expected);
const expectMissing = async (directory: string, relative: string) =>
  expect(fs.stat(path.join(directory, relative))).rejects.toMatchObject({ code: "ENOENT" });

export async function proveWorkspaceWaitAttribution(owner: LocalWorkspaceOwner) {
  using _ = await prepareSandboxCheckpointFixture(owner);
  const stores = await import("./local-workspace-store.js");
  const projections = await import("./local-workspace-projection.js");
  const entered = createDeferred();
  const release = createDeferred();
  const admitted = createDeferred();
  const joined = createDeferred();
  const events: diagnostics.DiagnosticPhaseSnapshot[] = [];
  vi.spyOn(diagnostics, "createQueuedDiagnosticPhaseEmitter").mockReturnValue((event) =>
    events.push(event),
  );
  let clock = 0;
  vi.spyOn(performance, "now").mockImplementation(() => clock);
  const holder = stores.withLocalWorkspaceStore({ worktreeId: owner.worktree.id }, async () => {
    entered.resolve();
    await release.promise;
  });
  await awaitGateBeforeSettlement(entered.promise, holder, "Projection custody was not acquired");
  const withStore = stores.withLocalWorkspaceStore;
  vi.spyOn(stores, "withLocalWorkspaceStore").mockImplementation((...args) => {
    const result = withStore(...args);
    admitted.resolve();
    return result;
  });
  const join = projections.withLocalWorkspacePreparation;
  let callers = 0;
  vi.spyOn(projections, "withLocalWorkspacePreparation").mockImplementation((...args) => {
    const result = join(...args);
    if (++callers === 2) {
      joined.resolve();
    }
    return result;
  });
  const prepare = () =>
    withWorktreePreparationTiming("sandbox", () => prepareSandboxCheckpointFixture(owner));
  const first = prepare();
  let second: typeof first | undefined;
  try {
    await awaitGateBeforeSettlement(
      admitted.promise,
      first,
      "Preparation did not wait for custody",
    );
    second = prepare();
    await awaitGateBeforeSettlement(
      joined.promise,
      second,
      "Preparation did not join its producer",
    );
    clock = 100;
  } finally {
    release.resolve();
    const results = await Promise.allSettled([holder, first, second]);
    for (const result of results) {
      if (result.status === "fulfilled") {
        result.value?.[Symbol.dispose]();
      }
    }
  }
  await Promise.all([holder, first, second]);
  expect(events).toHaveLength(2);
  for (const event of events) {
    expect(event).toMatchObject({
      durationMs: 100,
      details: { kind: "sandbox", workspaceWait: 100, unattributedMs: 0 },
    });
  }
  expect(events.some((event) => event.details?.template === "reused")).toBe(true);
}

export async function proveConcurrentWorkspacePreparation(owner: LocalWorkspaceOwner) {
  const stores = await import("./local-workspace-store.js");
  const withStore = stores.withLocalWorkspaceStore;
  const custody = vi.spyOn(stores, "withLocalWorkspaceStore");
  let probes = 0;
  custody.mockImplementation((params, run) =>
    withStore(params, (store) =>
      run({
        ...store,
        manifest: (row, action) => {
          if (action.kind === "probe") {
            probes++;
          }
          return store.manifest(row, action);
        },
      }),
    ),
  );
  for (const cold of [true, false]) {
    custody.mockClear();
    probes = 0;
    const preparations = await Promise.all(
      Array.from({ length: 8 }, () => prepareSandboxCheckpointFixture(owner)),
    );
    try {
      expect(new Set(preparations.map((prepared) => prepared.workspaceDir)).size).toBe(1);
      expect.soft(custody).toHaveBeenCalledTimes(cold ? 2 : 1);
      expect.soft(probes).toBe(cold ? 0 : 2);
      await writeText(preparations[0]!.workspaceDir, "source.txt", "later guest edit\n");
    } finally {
      for (const preparation of preparations) {
        preparation[Symbol.dispose]();
      }
    }
    using later = await prepareSandboxCheckpointFixture(owner);
    await expectText(owner.worktree.path, "source.txt", "later guest edit\n");
    await expectText(later.workspaceDir, "source.txt", "later guest edit\n");
  }
}

export async function provePreparationObservationBoundary(owner: LocalWorkspaceOwner) {
  using first = await prepareSandboxCheckpointFixture(owner);
  const stores = await import("./local-workspace-store.js");
  const withStore = stores.withLocalWorkspaceStore;
  const observed = createDeferred();
  const release = createDeferred();
  const admitted = createDeferred();
  const projections = await import("./local-workspace-projection.js");
  const join = projections.withLocalWorkspacePreparation;
  let callers = 0;
  vi.spyOn(projections, "withLocalWorkspacePreparation").mockImplementation((...args) => {
    const result = join(...args);
    if (++callers === 2) {
      admitted.resolve();
    }
    return result;
  });
  let paused = false;
  vi.spyOn(stores, "withLocalWorkspaceStore").mockImplementation((params, run) =>
    withStore(params, (store) =>
      run({
        ...store,
        manifest: async (row, action) => {
          const result = await store.manifest(row, action);
          if (!paused && action.kind === "probe" && action.target === "canonical") {
            paused = true;
            observed.resolve();
            await release.promise;
          }
          return result;
        },
      }),
    ),
  );
  const early = prepareSandboxCheckpointFixture(owner);
  let late: typeof early | undefined;
  try {
    await awaitGateBeforeSettlement(
      observed.promise,
      early,
      "Preparation did not observe canonical files",
    );
    await writeText(owner.worktree.path, "source.txt", "edit after observation\n");
    late = prepareSandboxCheckpointFixture(owner);
    await awaitGateBeforeSettlement(admitted.promise, late, "Later preparation did not enter");
  } finally {
    release.resolve();
    const results = await Promise.allSettled([early, late]);
    for (const result of results) {
      if (result.status === "fulfilled") {
        result.value?.[Symbol.dispose]();
      }
    }
  }
  await Promise.all([early, late]);
  await expectText(first.workspaceDir, "source.txt", "edit after observation\n");
}

export async function provePreparationWaiterAuthority(
  owner: LocalWorkspaceOwner,
  mode: "cancel waiter" | "revoke waiter" | "cancel producer" | "failed producer" | "other session",
) {
  using _ = await prepareSandboxCheckpointFixture(owner);
  const stores = await import("./local-workspace-store.js");
  const projections = await import("./local-workspace-projection.js");
  const withStore = stores.withLocalWorkspaceStore;
  const join = projections.withLocalWorkspacePreparation;
  const entered = createDeferred();
  const admitted = createDeferred();
  const release = createDeferred();
  let held = false;
  let callers = 0;
  vi.spyOn(projections, "withLocalWorkspacePreparation").mockImplementation((...args) => {
    const result = join(...args);
    if (++callers === 2) {
      admitted.resolve();
    }
    return result;
  });
  vi.spyOn(stores, "withLocalWorkspaceStore").mockImplementation((params, run) =>
    withStore(params, async (store) => {
      if (!held) {
        held = true;
        entered.resolve();
        await release.promise;
        if (mode === "failed producer") {
          throw new Error("synthetic storage failure");
        }
      }
      return run(store);
    }),
  );
  const producerStop = new AbortController();
  const waiterStop = new AbortController();
  let revoked = false;
  const producer = prepareSandboxCheckpointFixture(owner, undefined, producerStop.signal);
  let waiter: typeof producer | undefined;
  try {
    await awaitGateBeforeSettlement(entered.promise, producer, "Producer did not acquire custody");
    waiter = prepareSandboxCheckpointFixture(
      mode === "other session" ? { ...owner, sessionId: "another-incarnation" } : owner,
      () => {
        if (revoked) {
          throw new Error("waiter revoked");
        }
      },
      waiterStop.signal,
    );
    await awaitGateBeforeSettlement(admitted.promise, waiter, "Waiter did not enter preparation");
    if (mode === "cancel waiter") {
      waiterStop.abort(new Error("waiter stopped"));
      await expect(waiter).rejects.toBe(waiterStop.signal.reason);
    }
    revoked = mode === "revoke waiter";
    if (mode === "cancel producer") {
      producerStop.abort(new Error("producer stopped"));
    }
  } finally {
    release.resolve();
    const results = await Promise.allSettled([producer, waiter]);
    for (const result of results) {
      if (result.status === "fulfilled") {
        result.value?.[Symbol.dispose]();
      }
    }
    expect(results[0]?.status).toBe(
      mode === "cancel producer" || mode === "failed producer" ? "rejected" : "fulfilled",
    );
    expect(results[1]?.status).toBe(mode === "cancel producer" ? "fulfilled" : "rejected");
    if (mode === "revoke waiter" || mode === "other session") {
      expect(results[1]).toMatchObject({
        reason: {
          message: expect.stringContaining(
            mode === "revoke waiter" ? "waiter revoked" : "different session incarnation",
          ),
        },
      });
    }
  }
}

export async function proveWorkspaceIncarnationRecovery(
  owner: LocalWorkspaceOwner,
  change: "lifecycle reset" | "replacement session",
  revoke: () => void,
) {
  const prepare = () => withLocalWorkspaceProjection(owner, (state) => state.prepare());
  const projection = await prepare();
  await writeText(projection, "source.txt", "unaccepted edit\n");
  if (change === "lifecycle reset") {
    const resumed = { ...owner, lifecycleRevision: randomUUID() };
    expect(await withLocalWorkspaceProjection(resumed, (state) => state.prepare())).toBe(
      projection,
    );
    await expectText(owner.worktree.path, "source.txt", "unaccepted edit\n");
    expect((await readLocalWorkspaceProjection(owner.worktree.id))?.lifecycle_revision).toBe(
      resumed.lifecycleRevision,
    );
  } else {
    await expect(
      withLocalWorkspaceProjection({ ...owner, sessionId: randomUUID() }, (state) =>
        state.prepare(),
      ),
    ).rejects.toThrow("different session incarnation");
    await expectText(projection, "source.txt", "unaccepted edit\n");
    revoke();
    await expect(prepare()).rejects.toThrow("revoked");
  }
}

export async function proveWarmWorkspaceReuse(owner: LocalWorkspaceOwner) {
  const canonical = owner.worktree.path;
  const quiescence = await import("../../agents/sandbox/local-workspace-quiescence.js");
  using first = await prepareSandboxCheckpointFixture(owner);
  const quiesce = vi.spyOn(quiescence, "quiesceLocalWorkspace");
  using unchanged = await prepareSandboxCheckpointFixture(owner);
  expect(unchanged.workspaceDir).toBe(first.workspaceDir);
  expect(quiesce).not.toHaveBeenCalled();

  const source = path.join(first.workspaceDir, "source.txt");
  const before = await fs.stat(source);
  await writeText(first.workspaceDir, "source.txt", "modified\n");
  await fs.utimes(source, before.atime, before.mtime);
  using guestEdit = await prepareSandboxCheckpointFixture(owner);
  expect(quiesce).toHaveBeenCalledTimes(1);
  await expectText(canonical, "source.txt", "modified\n");
  await expectText(guestEdit.workspaceDir, "source.txt", "modified\n");

  await writeText(canonical, "source.txt", "host edit\n");
  using hostEdit = await prepareSandboxCheckpointFixture(owner);
  expect(quiesce).toHaveBeenCalledTimes(2);
  await expectText(hostEdit.workspaceDir, "source.txt", "host edit\n");
  await writeText(canonical, "added.txt", "admitted host file\n");
  await requireGit(canonical, ["add", "added.txt"]);
  using admitted = await prepareSandboxCheckpointFixture(owner);
  await expectText(admitted.workspaceDir, "added.txt", "admitted host file\n");
  await fs.rm(path.join(admitted.workspaceDir, "added.txt"));
  using deleted = await prepareSandboxCheckpointFixture(owner);
  await expectMissing(canonical, "added.txt");
  await expectMissing(deleted.workspaceDir, "added.txt");
  expect((await readLocalWorkspaceProjection(owner.worktree.id))?.pending_ref).toBeNull();
}

export async function proveWarmWorkspaceReuseFailure(
  owner: LocalWorkspaceOwner,
  failure: "read" | "authority" | "observation" | "cancel",
  revoke: () => void,
) {
  using first = await prepareSandboxCheckpointFixture(owner);
  const stores = await import("./local-workspace-store.js");
  const quiescence = await import("../../agents/sandbox/local-workspace-quiescence.js");
  const quiesce = vi.spyOn(quiescence, "quiesceLocalWorkspace");
  const withStore = stores.withLocalWorkspaceStore;
  const cancellation = new AbortController();
  let failed = false;
  vi.spyOn(stores, "withLocalWorkspaceStore").mockImplementation((params, run) =>
    withStore(params, (store) =>
      run({
        ...store,
        manifest: async (row, action) => {
          if (action.kind === "probe" && !failed && failure !== "observation") {
            failed = true;
            if (failure === "authority") {
              revoke();
            }
            if (failure === "cancel") {
              cancellation.abort(new Error("reuse cancelled"));
            }
            throw new Error("probe read failed");
          }
          return store.manifest(row, action);
        },
        accept: async (prepared, authority) => {
          if (failure === "observation") {
            failed = true;
            throw new Error("observation acceptance failed");
          }
          return store.accept(prepared, authority);
        },
      }),
    ),
  );
  if (failure === "read") {
    using recovered = await prepareSandboxCheckpointFixture(owner);
    expect(recovered.workspaceDir).toBe(first.workspaceDir);
    expect(quiesce).toHaveBeenCalledOnce();
  } else if (failure === "cancel") {
    await expect(
      prepareSandboxCheckpointFixture(owner, undefined, cancellation.signal),
    ).rejects.toMatchObject({ code: "OPENCLAW_STATE_LEASE_ABORTED" });
    expect(quiesce).not.toHaveBeenCalled();
  } else {
    await expect(prepareSandboxCheckpointFixture(owner)).rejects.toThrow(
      failure === "authority" ? "revoked" : "observation acceptance failed",
    );
    expect(quiesce).not.toHaveBeenCalled();
  }
  expect(failed).toBe(true);
  await expectText(owner.worktree.path, "source.txt", "original\n");
  await expectText(first.workspaceDir, "source.txt", "original\n");
}

export async function proveWarmWorkspaceConflictRecovery(owner: LocalWorkspaceOwner) {
  const canonical = owner.worktree.path;
  using first = await prepareSandboxCheckpointFixture(owner);
  const projection = first.workspaceDir;
  await writeText(projection, "source.txt", "guest conflict\n");
  await writeText(canonical, "source.txt", "human conflict\n");
  await expect(
    withLocalWorkspaceProjection(owner, (state) => state.synchronize("canonical")),
  ).rejects.toThrow("conflict");
  await expect(withLocalWorkspaceProjection(owner, (state) => state.prepare())).rejects.toThrow(
    "conflict",
  );
  expect((await readLocalWorkspaceProjection(owner.worktree.id))?.pending_ref).toBeTruthy();
  await expectText(projection, "source.txt", "guest conflict\n");
  await expectText(canonical, "source.txt", "human conflict\n");
  await closeOpenClawStateDatabaseAsync();
  await expect(prepareSandboxCheckpointFixture(owner)).rejects.toThrow("conflict");
  await expectText(projection, "source.txt", "guest conflict\n");
  await expectText(canonical, "source.txt", "human conflict\n");
  await writeText(canonical, "source.txt", "original\n");
  using recovered = await prepareSandboxCheckpointFixture(owner);
  expect(recovered.workspaceDir).toBe(projection);
  await expectText(canonical, "source.txt", "guest conflict\n");
  expect((await readLocalWorkspaceProjection(owner.worktree.id))?.pending_ref).toBeNull();
}

/** Keep native projection/registry custody; gate only the expensive cold-template boundary. */
export async function proveColdPreparationCapacityIsolation(
  owner: LocalWorkspaceOwner,
  signal: AbortSignal,
) {
  const [
    { prepareLocalSandboxWorkspace },
    { resolveSandboxConfigForAgent },
    templates,
    leases,
    { WORKTREE_CREATE_LEASE_SCOPE, WORKTREE_MUTATION_LEASE_SCOPE },
    { captureWorktreeRunEndContext },
    { insertRegistryWorktree, deleteRegistryWorktree },
    { acquireWorktreeRunLease },
    { ManagedWorktreeService },
    { replaceSessionEntry },
    { readWorktreeSlotCount },
  ] = await Promise.all([
    import("../../agents/sandbox/local-workspace.js"),
    import("../../agents/sandbox/config.js"),
    import("./local-workspace-template.js"),
    import("../../state/openclaw-state-lease.js"),
    import("../../agents/worktrees/capacity-contract.js"),
    import("../../agents/worktrees/run-end-lifecycle.js"),
    import("../../agents/worktrees/registry.js"),
    import("../../agents/worktrees/run-lease.js"),
    import("../../agents/worktrees/service.js"),
    import("../../config/sessions/session-accessor.js"),
    import("../../agents/worktrees/pending-slots.js"),
  ]);
  await insertRegistryWorktree(process.env, owner.worktree);
  await replaceSessionEntry(
    { agentId: owner.agentId, sessionKey: owner.sessionKey },
    {
      sessionId: owner.sessionId,
      updatedAt: 1,
      worktree: {
        id: owner.worktree.id,
        branch: owner.worktree.branch,
        repoRoot: owner.worktree.repoRoot,
      },
    },
  );
  const active = [await acquireWorktreeRunLease(owner.worktree.id)];
  const entered = createDeferred();
  const release = createDeferred();
  vi.spyOn(templates, "cloneLocalWorkspaceTemplate").mockImplementation(async ({ guard }) => {
    guard.commitGuard();
    entered.resolve();
    await release.promise;
    guard.commitGuard();
    return false;
  });
  const service = new ManagedWorktreeService({
    getConfig: () => ({
      worktreeMaxCount: 2,
      worktreeAcceleration: false,
      worktreeRoot: path.join(path.dirname(owner.worktree.path), "other-worktrees"),
    }),
  });
  const preparing = prepareLocalSandboxWorkspace({
    cfg: {},
    agentId: owner.agentId,
    sessionKey: owner.sessionKey,
    workspaceDir: owner.worktree.path,
    sandbox: resolveSandboxConfigForAgent({}, owner.agentId),
    signal,
  });
  let secondId: string | undefined;
  try {
    await withinTest(
      awaitGateBeforeSettlement(entered.promise, preparing, "Cold preparation never started"),
      signal,
    );
    // Fail immediately on the old global holder rather than waiting for a test timeout.
    const contend = (scope: string, key: string) =>
      leases.withOpenClawStateLeaseAsync(
        { scope, key, leaseMs: 60_000, waitMs: 0 },
        captureWorktreeRunEndContext(process.env),
        async () => {},
      );
    await contend(WORKTREE_CREATE_LEASE_SCOPE, "capacity");
    await expect(contend(WORKTREE_MUTATION_LEASE_SCOPE, owner.worktree.id)).rejects.toMatchObject({
      code: "OPENCLAW_STATE_LEASE_HELD",
    });
    const second = await withinTest(
      service.create({
        repoRoot: owner.worktree.repoRoot,
        name: "independent",
        baseRef: "HEAD",
        signal,
      }),
      signal,
    );
    secondId = second.id;
    active.push(await acquireWorktreeRunLease(second.id));
    await expectText(second.path, "source.txt", "original\n");
    await expect(
      service.create({
        repoRoot: owner.worktree.repoRoot,
        name: "overflow",
        baseRef: "HEAD",
        signal,
      }),
    ).rejects.toThrow("Managed worktree cap 2 reached");
    expect(await readWorktreeSlotCount(process.env)).toBe(2);
    release.resolve();
    const projection = await preparing;
    expect(projection).toBeDefined();
    await expectText(projection!.workspaceDir, "source.txt", "original\n");
  } finally {
    release.resolve();
    const result = await preparing.catch(() => undefined);
    result?.[Symbol.dispose]();
    await Promise.all(active.map((lease) => lease.release()));
    if (secondId) {
      await deleteRegistryWorktree(process.env, secondId);
    }
  }
}
