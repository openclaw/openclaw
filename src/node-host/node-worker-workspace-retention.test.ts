import { createHash } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  fixtureReceiptClientSource,
  openFixtureReceiptChannel,
} from "../../test/helpers/fixture-receipts.js";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../state/openclaw-state-db.js";
import type { NodeWorkerWorkspaceRetainInput } from "../worker/node-workspace-retain-protocol.js";
import { createNodeWorkerSupervisor } from "./node-worker-supervisor.js";
import {
  TEST_WORKER_ENDPOINT,
  testNodeWorkerEnvironmentIdentity,
  testWorkerLaunchInput,
  writeNodeWorkerFixture,
} from "./node-worker-supervisor.test-support.js";
import * as workspaceTransfer from "./node-worker-transfer-client.js";
import { NodeWorkerWorkspaceRuntime } from "./node-worker-workspace.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
    cleanup();
  }),
);

type Launch = ReturnType<typeof testWorkerLaunchInput>;
type Retain = NodeWorkerWorkspaceRetainInput["retain"];
function workspaceFiles(bundleRoot: string, input: Launch) {
  const hash = (value: string, length: number) =>
    createHash("sha256").update(value).digest("hex").slice(0, length);
  const session = path.join(
    bundleRoot,
    input.gatewayNamespace,
    "workspaces",
    hash(input.descriptor.admission.environmentId, 16),
    hash(input.descriptor.admission.sessionId, 32),
  );
  const directory = (generation = input.descriptor.admission.ownerEpoch) =>
    path.join(session, String(generation));
  const write = (file: string, content: string) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  };
  const seed = (generation = input.descriptor.admission.ownerEpoch) => {
    write(path.join(directory(generation), "sentinel.txt"), String(generation));
    return directory(generation);
  };
  const manifest = (digest: string) => {
    const file = path.join(session, ".openclaw-worker", "manifests", `${digest}.json`);
    write(file, "{}\n");
    return file;
  };
  return { session, directory, seed, manifest };
}

function retainInput(
  input: Launch,
  sequence: number,
  retain: Retain = [],
): NodeWorkerWorkspaceRetainInput {
  return {
    version: 1,
    gatewayNamespace: input.gatewayNamespace,
    controllerId: "gateway-controller-1",
    sequence,
    retain,
  };
}

function fixture(name: string) {
  const root = fs.realpathSync.native(tempDirs.make(`node-worker-${name}-`));
  const workspace = new NodeWorkerWorkspaceRuntime({ root });
  const input = testWorkerLaunchInput("/unused", name);
  const generation = input.descriptor.admission.ownerEpoch;
  const entry = {
    environmentId: input.descriptor.admission.environmentId,
    sessionId: input.descriptor.admission.sessionId,
    generation,
    manifestRefs: [],
  };
  const collect = (sequence: number, retain: Retain = [], signal?: AbortSignal) =>
    workspace.applyRetainSnapshot(retainInput(input, sequence, retain), async () => [], signal);
  return { root, workspace, input, generation, entry, collect, ...workspaceFiles(root, input) };
}

function managedFixture(name: string) {
  const f = fixture(name);
  const workspaceDir = f.seed();
  const request = {
    workspaceDir,
    environmentId: f.entry.environmentId,
    sessionId: f.entry.sessionId,
    ownerEpoch: f.generation,
    sessionKey: "agent:main:managed",
  };
  return { ...f, workspaceDir, request };
}

function supervisorFixture(name: string) {
  const root = tempDirs.make(`node-worker-${name}-`);
  const { bundleRoot, env, workspaceDir } = writeNodeWorkerFixture(root);
  const input = testWorkerLaunchInput(workspaceDir, name);
  return {
    input,
    ...workspaceFiles(bundleRoot, input),
    supervisor: createNodeWorkerSupervisor({ bundleRoot, env }),
  };
}

function expectPaths(paths: string[], exists: boolean) {
  expect(paths.map((file) => fs.existsSync(file))).toEqual(paths.map(() => exists));
}

function holdLstat(target: string) {
  const entered = createDeferred();
  const release = createDeferred();
  const original = fsp.lstat.bind(fsp);
  let blocked = false;
  vi.spyOn(fsp, "lstat").mockImplementation(async (candidate) => {
    if (!blocked && String(candidate) === target) {
      blocked = true;
      entered.resolve();
      await release.promise;
    }
    return await original(candidate);
  });
  return { entered, release };
}

afterEach(() => {
  vi.restoreAllMocks();
});

it("preserves legacy synchronous plugin acquisition for the exact canonical placement workspace identity", () => {
  const { root, workspace, workspaceDir, request } = managedFixture("managed-identity");

  const claim = workspace.acquireManagedWorkspace(request);
  expect(claim.workspaceDir).toBe(workspaceDir);
  claim.release();
  claim.release();

  for (const changed of [
    { workspaceDir: root },
    { environmentId: "different-environment" },
    { sessionId: "different-session" },
    { ownerEpoch: request.ownerEpoch + 1 },
    { sessionKey: "" },
  ]) {
    expect(() => workspace.acquireManagedWorkspace({ ...request, ...changed })).toThrow(
      "does not own the requested workspace",
    );
  }

  const linked = path.join(path.dirname(workspaceDir), "linked-workspace");
  fs.symlinkSync(workspaceDir, linked, process.platform === "win32" ? "junction" : "dir");
  expect(() => workspace.acquireManagedWorkspace({ ...request, workspaceDir: linked })).toThrow(
    "does not own the requested workspace",
  );
});

it("keeps an in-flight removal fenced until it settles after cancellation", async () => {
  const { workspace, collect, workspaceDir, request } = managedFixture("managed-removal-race");
  const removalStarted = createDeferred();
  const finishRemoval = createDeferred();
  const controller = new AbortController();
  const remove = fsp.rm.bind(fsp);
  vi.spyOn(fsp, "rm").mockImplementation(async (target, options) => {
    if (String(target) === workspaceDir) {
      removalStarted.resolve();
      await finishRemoval.promise;
    }
    return await remove(target, options);
  });
  const retention = collect(1, [], controller.signal).catch((error: unknown) => error);

  try {
    await removalStarted.promise;
    controller.abort(new Error("retention cancelled"));
    expect(fs.existsSync(workspaceDir)).toBe(true);
    await expect(workspace.acquireManagedWorkspaceAsync(request)).rejects.toThrow(
      "workspace is being removed",
    );
  } finally {
    finishRemoval.resolve();
  }
  expect(await retention).toBe(controller.signal.reason);
  expect(fs.existsSync(workspaceDir)).toBe(false);
});

it.each(["manifest", "metadata"] as const)(
  "cancels before deleting a %s verified after cancellation and resumes on replay",
  async (kind) => {
    const { collect, entry, seed, manifest, session } = fixture("cancel-retention");
    const retained = kind === "metadata" ? undefined : seed(2);
    const retainedEntries = retained ? [{ ...entry, generation: 2 }] : [];
    const target =
      kind === "manifest" ? manifest("b".repeat(64)) : path.join(session, ".openclaw-worker");
    if (kind === "metadata") {
      fs.mkdirSync(target, { recursive: true });
      fs.writeFileSync(path.join(target, "sentinel.txt"), "preserve until resumed");
    }
    const { entered, release } = holdLstat(target);
    const controller = new AbortController();
    const retention = collect(1, retainedEntries, controller.signal).catch(
      (error: unknown) => error,
    );
    try {
      await entered.promise;
      controller.abort(new Error("retention cancelled"));
    } finally {
      release.resolve();
    }
    expect(await retention).toBe(controller.signal.reason);
    expect(fs.existsSync(target)).toBe(true);

    await expect(collect(1, retainedEntries)).resolves.toMatchObject({
      applied: true,
      hasMore: false,
    });
    expect(fs.existsSync(target)).toBe(false);
    if (retained) {
      expect(fs.existsSync(retained)).toBe(true);
    }
  },
);

it("settles an issued deletion but leaves empty parents when cancelled", async () => {
  const { collect, manifest: seedManifest, session } = fixture("cancel-parent-retention");
  const manifest = seedManifest("b".repeat(64));
  const controller = new AbortController();
  const reason = new Error("retention cancelled");
  const originalRemove = fsp.rm.bind(fsp);
  vi.spyOn(fsp, "rm").mockImplementation(async (target, options) => {
    await originalRemove(target, options);
    if (String(target) === manifest) {
      controller.abort(reason);
    }
  });
  await expect(collect(1, [], controller.signal)).rejects.toBe(reason);
  expect(fs.existsSync(manifest)).toBe(false);
  expect(fs.existsSync(path.dirname(manifest))).toBe(true);

  await collect(1);
  expect(fs.existsSync(session)).toBe(false);
});

it("preserves workspaces until the first snapshot and continues a bounded backlog on replay", async () => {
  const { seed, session, input, supervisor } = supervisorFixture("backlog-retention");
  const generations = Array.from({ length: 261 }, (_, generation) => seed(generation));
  await supervisor.initialize();
  expectPaths(generations, true);
  const snapshot = retainInput(input, 1);

  const first = await supervisor.retainWorkspaces(snapshot);
  const second = await supervisor.retainWorkspaces(snapshot);

  expect(first).toMatchObject({ applied: true, deleted: 256, hasMore: true });
  expect(second).toMatchObject({ applied: true, hasMore: false });
  expect(fs.existsSync(session)).toBe(false);
  await supervisor.close();
});

it("retains transferred manifests across command gaps until superseded or retired", async () => {
  const f = fixture("transfer-retention");
  const { workspace, input, generation, entry, collect } = f;
  const workspaceDir = f.seed();
  const baseDigest = "b".repeat(64);
  const baseManifest = f.manifest(baseDigest);
  const retainedEntry = {
    ...entry,
    manifestRefs: [`sha256:${baseDigest}`],
  };
  const runTransfer = vi.spyOn(workspaceTransfer, "runNodeWorkerWorkspaceTransfer");
  const transferManifest = async (direction: "upload" | "download", digest: string) => {
    const manifestRef = `sha256:${digest}`;
    const manifest = f.manifest(digest);
    runTransfer.mockResolvedValueOnce(manifestRef);
    await workspace.exec(
      {
        gatewayNamespace: input.gatewayNamespace,
        environmentId: retainedEntry.environmentId,
        sessionId: retainedEntry.sessionId,
        generation,
        argv: ["node"],
        transfer:
          direction === "upload"
            ? {
                direction,
                token: "test-token",
                baseManifestRef: `sha256:${baseDigest}`,
                referenceManifestRef: `sha256:${baseDigest}`,
              }
            : { direction, token: "test-token", manifestRef },
      },
      undefined,
      { url: "http://127.0.0.1:1" },
    );
    return manifest;
  };

  const first = await transferManifest("upload", "c".repeat(64));
  const artifacts = [
    `.${generation}.workspace-transfer-stale`,
    `${generation}.previous-123-stale`,
  ].map((name) => path.join(f.session, name));
  for (const artifact of artifacts) {
    fs.mkdirSync(artifact);
  }
  await collect(1, [retainedEntry]);

  expect(fs.existsSync(first)).toBe(true);
  expect(artifacts.every((artifact) => !fs.existsSync(artifact))).toBe(true);

  const latest = await transferManifest("download", "d".repeat(64));
  await collect(2, [retainedEntry]);

  expect(fs.existsSync(first)).toBe(false);
  expectPaths([latest, baseManifest], true);

  const sibling = f.seed(generation + 1);
  await collect(3, [{ ...retainedEntry, generation: generation + 1 }]);

  expectPaths([workspaceDir, latest], false);
  expect(fs.existsSync(sibling)).toBe(true);
});

it("keeps a retained worker workspace after turn completion until environment teardown", async () => {
  const root = tempDirs.make("node-worker-workspace-retention-active-");
  const { bundleRoot, env, workspaceDir } = writeNodeWorkerFixture(root);
  const input = testWorkerLaunchInput(workspaceDir, "active-retention", "background-start");
  const active = workspaceFiles(bundleRoot, input).seed();
  input.descriptor.assignment.workspaceDir = fs.realpathSync.native(active);
  const supervisor = createNodeWorkerSupervisor({ bundleRoot, env });

  try {
    await supervisor.launch(input, TEST_WORKER_ENDPOINT);
    await vi.waitFor(
      async () => expect((await supervisor.status(input.launchId))?.state).toBe("completed"),
      { timeout: 5_000 },
    );
    await supervisor.retainWorkspaces(retainInput(input, 1, []));
    expect(fs.existsSync(active)).toBe(true);

    await supervisor.stopEnvironment(testNodeWorkerEnvironmentIdentity(input));
    await supervisor.retainWorkspaces(retainInput(input, 2, []));
    expect(fs.existsSync(active)).toBe(false);
  } finally {
    await supervisor.close();
  }
});

it("rereads a launch reservation immediately before deleting", async () => {
  const { workspace, input, seed } = fixture("reservation-race");
  const generation = seed();
  let reservations: ReturnType<typeof testNodeWorkerEnvironmentIdentity>[] = [];
  const { entered, release } = holdLstat(generation);
  const retention = workspace.applyRetainSnapshot(
    retainInput(input, 1, []),
    async () => reservations,
  );
  await entered.promise;
  reservations = [testNodeWorkerEnvironmentIdentity(input)];
  release.resolve();

  await retention;

  expect(fs.existsSync(generation)).toBe(true);
});

it("protects an in-flight workspace command admitted during collection", async ({ signal }) => {
  const { directory, workspace, input, entry, collect } = fixture("command-retention");
  const started = path.join(directory(), "started");
  const receipts = await openFixtureReceiptChannel();
  const command = workspace.exec({
    gatewayNamespace: input.gatewayNamespace,
    environmentId: entry.environmentId,
    sessionId: entry.sessionId,
    generation: entry.generation,
    argv: [
      "node",
      "--input-type=module",
      "-e",
      `${fixtureReceiptClientSource(receipts.endpoint)}
import fs from "node:fs";
fs.writeFileSync("started", "");
sendReceipt("command", "started");
await awaitRelease("command", "release");`,
    ],
  });
  try {
    await withinTest(
      awaitGateBeforeSettlement(
        receipts.waitFor("command", "started"),
        command,
        "Workspace command settled before starting",
      ).catch((error: unknown) => {
        // The command can settle before its receipt crosses the separate socket.
        if (!fs.existsSync(started)) {
          throw error;
        }
      }),
      signal,
    );
    const retention = collect(1);
    receipts.release("command", "release");

    await withinTest(Promise.all([command, retention]), signal);
    expect(fs.existsSync(path.dirname(started))).toBe(true);

    await withinTest(collect(2), signal);
    expect(fs.existsSync(path.dirname(started))).toBe(false);
  } finally {
    receipts.release("command", "release");
    await command.catch(() => {});
    await receipts.close();
  }
});

it("rejects conflicting replay and ignores an older sequence", async () => {
  const { seed, entry, collect } = fixture("sequence-retention");
  const generation = seed(5);
  await collect(2, [{ ...entry, generation: 5, manifestRefs: null }]);
  await expect(collect(1)).resolves.toEqual({
    applied: false,
    deleted: 0,
    hasMore: false,
  });
  await expect(collect(2)).rejects.toThrow("sequence changed contents");
  expect(fs.existsSync(generation)).toBe(true);
});

it("keeps other Gateway namespaces isolated", async () => {
  const { root, workspace, input: first, seed } = fixture("namespace-a");
  const second = testWorkerLaunchInput("/unused", "namespace-b");
  second.gatewayNamespace = "gateway-other";
  seed(1);
  const other = workspaceFiles(root, second).seed(1);

  await workspace.applyRetainSnapshot(retainInput(first, 1, []), async () => []);

  expect(fs.existsSync(other)).toBe(true);
});
