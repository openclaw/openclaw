import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { requireGit } from "../../agents/worktrees/git.js";
import type { WorkerProvider } from "../../plugins/types.js";
import { readWorkerProjectPreparation } from "./preparation-identity.schema.js";
import { createWorkerProviderIntent } from "./provider-intent.js";
import { nodeArtifacts, repository } from "./provider-lifecycle.test-support.js";
import * as support from "./service.test-support.js";
import type { WorkerEnvironmentRecord } from "./store.js";

describe("prepared worker intent admission", () => {
  support.setupWorkerEnvironmentServiceSuite();

  async function fixture(setup = false) {
    const { root: projectPath } = await repository("project", {
      setup,
      disableSigning: true,
      content: "base\n",
    });
    const target = vi.fn<NonNullable<WorkerProvider["resolvePreparationTarget"]>>(
      (_profile, machineClass, os) => ({
        machineClass: machineClass ?? "small",
        platform: os ?? "linux",
        arch: "amd64",
      }),
    );
    const provider = support.createProvider({
      requiresNodeEnrollment: true,
      supportsProjectPreparation: () => true,
      resolvePreparationTarget: target,
    });
    const prepareNodeArtifacts = vi.fn(async () => nodeArtifacts(["runtime-plugin"]));
    const resumeProvision = vi.fn(async (record: WorkerEnvironmentRecord) => record);
    const owner = createWorkerProviderIntent({
      store: support.testState.store,
      getConfig: () => support.testState.config,
      projectNamespace: "gateway-test",
      providerFor: () => provider,
      prepareNodeArtifacts,
      resumeProvision,
      isStopping: () => false,
      withLock: async (_environmentId, task) => task(),
    });
    const prepare = (options: Parameters<typeof owner.prepareIntent>[1] = {}) =>
      owner.prepareIntent("development", { projectPath, ...options });
    const create = (
      key: string,
      options: Parameters<typeof owner.createWithProfile>[2] = {},
      admitted?: Parameters<typeof owner.createWithProfile>[3],
    ) => owner.createWithProfile("development", key, { projectPath, ...options }, admitted);
    const spies = { target, prepareNodeArtifacts, resumeProvision };
    return { owner, provider, projectPath, spies, prepare, create };
  }

  it("keeps empty workspaces cold on providers with only setup commands", async () => {
    const f = await fixture();
    f.provider.supportsProjectPreparation = () => false;
    f.provider.runSetupCommand = async () => undefined;
    const intent = await f.owner.prepareIntent("development", { emptyWorkspace: true });
    expect(intent.profileSnapshot).not.toHaveProperty("project");
    expect(intent.profileSnapshot).not.toHaveProperty("runtimePreparation");
    expect(f.spies.prepareNodeArtifacts).not.toHaveBeenCalled();
  });

  it("admits exact local source and OS without allocating, and retains reusable facts after caller abort", async () => {
    const f = await fixture();
    const controller = new AbortController();
    const options = { machineClass: "large", os: "linux", signal: controller.signal };
    const intent = await f.prepare(options);
    expect(intent.profileSnapshot.project?.preparation?.key).toMatch(/^[a-f0-9]{64}$/u);
    expect(f.spies.target).toHaveBeenCalledWith({ region: "test" }, "large", "linux");
    expect(support.testState.store.list()).toEqual([]);
    expect(f.spies.resumeProvision).not.toHaveBeenCalled();
    controller.abort();
    expect(() => f.owner.assertPreparedIntentCurrent("development", intent)).not.toThrow();
    await f.create("admitted-local", { ...options, signal: undefined }, intent);
    expect(support.testState.store.list()).toHaveLength(1);
    expect(f.spies.resumeProvision).toHaveBeenCalledOnce();
  });

  it("replays a removed linked source through its canonical repository while rejecting other projects and commits", async () => {
    const f = await fixture();
    const linked = path.join(support.testState.root, "linked-source");
    await requireGit(f.projectPath, ["worktree", "add", "--detach", linked, "HEAD"]);
    await fs.writeFile(path.join(linked, "input.txt"), "session commit\n");
    await requireGit(linked, ["commit", "--quiet", "-am", "session"]);
    const options = { projectPath: linked };
    const admitted = await f.prepare(options);
    const stored = await f.create("linked-replay", options, admitted);
    await fs.writeFile(path.join(f.projectPath, "input.txt"), "new primary commit\n");
    await requireGit(f.projectPath, ["commit", "--quiet", "-am", "advance primary"]);
    const primaryCommit = await requireGit(f.projectPath, ["rev-parse", "HEAD"]);
    await requireGit(f.projectPath, ["worktree", "remove", linked]);

    const replayed = {
      environmentId: stored.environmentId,
      profileSnapshot: stored.profileSnapshot,
    };
    await expect(f.create("linked-replay")).resolves.toMatchObject(replayed);
    const nested = path.join(f.projectPath, "nested");
    await fs.mkdir(nested);
    await expect(f.create("linked-replay", { projectPath: nested })).resolves.toMatchObject(
      replayed,
    );
    expect((await f.prepare({ projectPath: nested })).profileSnapshot.project).toBeUndefined();

    const other = path.join(support.testState.root, "other-clone");
    await requireGit(support.testState.root, ["clone", "--no-hardlinks", f.projectPath, other]);
    await expect(f.create("linked-replay", { projectPath: other })).rejects.toThrow(
      "Idempotency key belongs to another project",
    );
    await expect(f.create("linked-replay", { projectCommit: primaryCommit })).rejects.toThrow(
      "Idempotency key belongs to another project preparation",
    );
    const changed = await f.prepare();
    await expect(f.create("linked-replay", {}, changed)).rejects.toThrow(
      "Idempotency key belongs to another project preparation",
    );
    expect(support.testState.store.get(stored.environmentId)?.profileSnapshot).toEqual(
      stored.profileSnapshot,
    );
    expect(f.spies.resumeProvision).toHaveBeenCalledTimes(3);
  });

  it("requires setup authority for reserves while preserving explicit session setup admission", async () => {
    const f = await fixture(true);
    const ordinary = await f.prepare();
    expect(ordinary.profileSnapshot.project?.preparation).toBeUndefined();
    const authorized = await f.prepare({ setupAuthorized: true });
    const skipped = await f.prepare({ runSetupScript: false });
    const authorizedKey = authorized.profileSnapshot.project?.preparation?.key;
    const skippedKey = skipped.profileSnapshot.project?.preparation?.key;
    expect(authorizedKey).toBeDefined();
    expect(skippedKey).toBeDefined();
    expect(skippedKey).not.toBe(authorizedKey);
    await f.create("session-setup", { runSetupScript: true });
    expect(
      readWorkerProjectPreparation(support.testState.store.list()[0]!.profileSnapshot.project)?.key,
    ).toBe(authorizedKey);
  });
});
