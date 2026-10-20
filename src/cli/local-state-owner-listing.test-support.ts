import fs from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../test/helpers/promise.js";
import { withWorktreeMutationLease } from "../agents/worktrees/allocation.js";
import { insertRegistryWorktree } from "../agents/worktrees/registry.js";
import type { ManagedWorktreeService } from "../agents/worktrees/service.js";
import type { ManagedWorktreeRecord } from "../agents/worktrees/types.js";
import * as backoff from "../infra/backoff.js";
import { acquireGatewayLock, type GatewayLockHandle } from "../infra/gateway-lock.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db.js";
import { runCliProcessChild } from "./cli-process-child.test-helpers.js";

type ListingOwnerFixture = {
  root: string;
  repo: string;
  env: NodeJS.ProcessEnv;
  service: ManagedWorktreeService;
  methods: string[];
  port: number;
  owner: GatewayLockHandle | null;
};

async function seedRecord(fixture: ListingOwnerFixture, id: string) {
  const record: ManagedWorktreeRecord = {
    id,
    name: id,
    repoRoot: fixture.repo,
    repoFingerprint: "0123456789abcdef",
    path: path.join(fixture.root, id),
    branch: `openclaw/${id}`,
    baseRef: "HEAD",
    ownerKind: "manual",
    createdAt: 1,
    lastActiveAt: 1,
  };
  await insertRegistryWorktree(fixture.env, record, { provisionedPaths: [] });
  return record;
}

async function changeOwner(fixture: ListingOwnerFixture, mode: "offline" | "embedded" | "gateway") {
  await closeOpenClawStateDatabaseAsync();
  await fixture.owner?.release();
  fixture.owner =
    mode === "offline"
      ? null
      : await acquireGatewayLock({
          env: fixture.env,
          ...(mode === "embedded" ? { role: "agent-embedded" as const } : { port: fixture.port }),
          allowInTests: true,
          timeoutMs: 0,
        });
}
const readRecord = async (fixture: ListingOwnerFixture, id: string) =>
  (await fixture.service.listRegistryRecords()).find((row) => row.id === id);
const readObservation = async (fixture: ListingOwnerFixture) =>
  JSON.parse(await fs.readFile(path.join(fixture.root, "control", "sql-observation.json"), "utf8"));

export function registerWorktreeListingOwnerTests(
  getFixture: () => ListingOwnerFixture,
  entrypoint: readonly string[],
) {
  const list = (env: NodeJS.ProcessEnv) =>
    runCliProcessChild({
      nodeArgs: [...entrypoint, "worktrees", "list", "--json"],
      env,
    });
  it("list: reports retirement candidates without mutating a foreign owner's registry", async () => {
    const fixture = getFixture();
    const { env, methods } = fixture;
    const record = await seedRecord(fixture, "list-foreign-custody");
    const held = createDeferred();
    const release = createDeferred();
    const holder = withWorktreeMutationLease({ env, id: record.id }, async () => {
      held.resolve();
      await release.promise;
    });
    await awaitGateBeforeSettlement(held.promise, holder, "Mutation custody was not acquired");
    const sleep = vi.spyOn(backoff, "sleepWithAbort").mockImplementationOnce(async () => {
      throw new Error("Foreign listing requested mutation custody");
    });
    const before = methods.length;
    try {
      const result = await list(env);
      expect(result.code, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        worktrees: expect.arrayContaining([record]),
        retirementCandidates: [record.id],
      });
      expect(methods.slice(before)).toEqual([]);
      expect(await readRecord(fixture, record.id)).toEqual(record);
      expect((await readObservation(fixture)).worktreeSql).toBe(0);
    } finally {
      release.resolve();
      await holder;
      sleep.mockRestore();
    }
  });

  it("list: rereads an absent checkout after offline mutation custody", async () => {
    const fixture = getFixture();
    const { env, service } = fixture;
    const record = await seedRecord(fixture, "list-live-custody");
    await changeOwner(fixture, "embedded");
    const held = createDeferred();
    const release = createDeferred();
    const waiting = createDeferred();
    const resume = createDeferred();
    const holder = withWorktreeMutationLease({ env, id: record.id }, async (guard) => {
      guard.commitGuard();
      held.resolve();
      await release.promise;
      guard.commitGuard();
    });
    await awaitGateBeforeSettlement(held.promise, holder, "Mutation custody was not acquired");
    const sleep = vi.spyOn(backoff, "sleepWithAbort").mockImplementationOnce(async () => {
      waiting.resolve();
      await resume.promise;
    });
    const listing = service.list();
    try {
      await awaitGateBeforeSettlement(
        waiting.promise,
        listing,
        "Listing settled without respecting worktree mutation custody",
      );
      fixture.owner!.assertCurrent();
      expect(await readRecord(fixture, record.id)).toEqual(record);
      await fs.mkdir(record.path);
      release.resolve();
      await holder;
      resume.resolve();
      expect(await listing).toContainEqual(record);
      expect(await readRecord(fixture, record.id)).toEqual(record);
    } finally {
      release.resolve();
      resume.resolve();
      await holder;
      await listing;
      sleep.mockRestore();
      await changeOwner(fixture, "gateway");
    }
  });

  it("list: retires an absent checkout under offline ownership", async () => {
    const fixture = getFixture();
    const { env, methods } = fixture;
    const record = await seedRecord(fixture, "list-offline-custody");
    await changeOwner(fixture, "offline");
    const before = methods.length;
    try {
      const result = await list(env);
      expect(result.code, result.stderr).toBe(0);
      expect(methods.slice(before)).toEqual([]);
      expect(JSON.parse(result.stdout).worktrees).not.toContainEqual(
        expect.objectContaining({ id: record.id }),
      );
      const observation = await readObservation(fixture);
      expect(observation.missingCustody).toBe(0);
      expect(observation.ownerPids.every((pid: number) => pid === observation.pid)).toBe(true);
    } finally {
      await changeOwner(fixture, "gateway");
    }
    expect((await readRecord(fixture, record.id))?.removedAt).toEqual(expect.any(Number));
  });
}
