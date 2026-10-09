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

const missingListingRecord = (fixture: ListingOwnerFixture, id: string): ManagedWorktreeRecord => ({
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
});

export function registerWorktreeListingOwnerTests(
  getFixture: () => ListingOwnerFixture,
  entrypoint: readonly string[],
) {
  it("list: reports retirement candidates without mutating a foreign owner's registry", async () => {
    const fixture = getFixture();
    const { root, env, service, methods } = fixture;
    const record = missingListingRecord(fixture, "list-foreign-custody");
    await insertRegistryWorktree(env, record, { provisionedPaths: [] });
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
      const result = await runCliProcessChild({
        nodeArgs: [...entrypoint, "worktrees", "list", "--json"],
        env,
      });
      expect(result.code, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        worktrees: expect.arrayContaining([record]),
        retirementCandidates: [record.id],
      });
      expect(methods.slice(before)).toEqual([]);
      expect((await service.listRegistryRecords()).find((row) => row.id === record.id)).toEqual(
        record,
      );
      expect(
        JSON.parse(await fs.readFile(path.join(root, "control", "sql-observation.json"), "utf8"))
          .worktreeSql,
      ).toBe(0);
    } finally {
      release.resolve();
      await holder;
      sleep.mockRestore();
    }
  });

  it("list: rereads an absent checkout after offline mutation custody", async () => {
    const fixture = getFixture();
    const { env, service } = fixture;
    const record = missingListingRecord(fixture, "list-live-custody");
    await insertRegistryWorktree(env, record, { provisionedPaths: [] });
    await closeOpenClawStateDatabaseAsync();
    await fixture.owner?.release();
    fixture.owner = await acquireGatewayLock({
      env,
      role: "agent-embedded",
      allowInTests: true,
      timeoutMs: 0,
    });
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
      expect((await service.listRegistryRecords()).find((row) => row.id === record.id)).toEqual(
        record,
      );
      await fs.mkdir(record.path);
      release.resolve();
      await holder;
      resume.resolve();
      expect(await listing).toContainEqual(record);
      expect((await service.listRegistryRecords()).find((row) => row.id === record.id)).toEqual(
        record,
      );
    } finally {
      release.resolve();
      resume.resolve();
      await holder;
      await listing;
      sleep.mockRestore();
      await closeOpenClawStateDatabaseAsync();
      await fixture.owner?.release();
      fixture.owner = await acquireGatewayLock({
        env,
        port: fixture.port,
        allowInTests: true,
        timeoutMs: 0,
      });
    }
  });

  it("list: retires an absent checkout under offline ownership", async () => {
    const fixture = getFixture();
    const { root, env, service, methods } = fixture;
    const record = missingListingRecord(fixture, "list-offline-custody");
    await insertRegistryWorktree(env, record, { provisionedPaths: [] });
    await closeOpenClawStateDatabaseAsync();
    await fixture.owner?.release();
    fixture.owner = null;
    const before = methods.length;
    try {
      const result = await runCliProcessChild({
        nodeArgs: [...entrypoint, "worktrees", "list", "--json"],
        env,
      });
      expect(result.code, result.stderr).toBe(0);
      expect(methods.slice(before)).toEqual([]);
      expect(JSON.parse(result.stdout).worktrees).not.toContainEqual(
        expect.objectContaining({ id: record.id }),
      );
      const observation = JSON.parse(
        await fs.readFile(path.join(root, "control", "sql-observation.json"), "utf8"),
      );
      expect(observation.missingCustody).toBe(0);
      expect(observation.ownerPids.every((pid: number) => pid === observation.pid)).toBe(true);
    } finally {
      fixture.owner = await acquireGatewayLock({
        env,
        port: fixture.port,
        allowInTests: true,
        timeoutMs: 0,
      });
    }
    expect(
      (await service.listRegistryRecords()).find((row) => row.id === record.id)?.removedAt,
    ).toEqual(expect.any(Number));
  });
}
