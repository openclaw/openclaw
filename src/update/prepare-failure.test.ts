import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { expect, it, vi } from "vitest";
import { resolveServiceManagerEnv } from "../daemon/service-process-env.js";
import { resolveUpdateInstallRoot } from "../infra/update-install-root.js";
import {
  prepareManagedHandoffLeaseStore,
  resolveManagedUpdateLeaseDatabasePath,
  type ManagedHandoffLease,
} from "../infra/update-managed-service-handoff-lease.js";
import { getUpdateRunAsync, listUpdateRunsAsync } from "../infra/update-run-reader.js";
import { createUpdateRunAsync } from "../infra/update-run-write.async.js";
import * as updateWrites from "../infra/update-run-write.async.js";
import {
  withArtifactPreservingStateReads,
  withOpenClawStateDatabaseReadSnapshot,
} from "../state/openclaw-state-db-readonly.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { VERSION } from "../version.js";
import { checkUpdateInstallationSlot } from "./installation-identity.js";
import { node, repository, root } from "./prepare.test-support.js";
import { prepareUpdate } from "./run.js";
import { createTrialPending, readTrial, resolvePrefix, switchLink, writeTrial } from "./store.js";
import * as targets from "./target.js";

const exec = promisify(execFile);

it("discards a rejected Git candidate without leaking its registration or touching another worktree", async () => {
  vi.stubEnv("HOME", root);
  vi.stubEnv("OPENCLAW_STATE_DIR", path.join(root, "state"));
  const target = await repository(false, ">=1", {
    ok: false,
    reason: "fixture release refusal",
    surfaces: [],
  });
  const git = (...args: string[]) => exec("git", ["-C", target.checkout, ...args]);
  const unrelated = path.join(root, "unrelated");
  await git("worktree", "add", "--detach", unrelated, target.sha);
  const before = (await git("worktree", "list", "--porcelain")).stdout;
  const registrations = path.join(target.checkout, ".git", "worktrees");
  const beforeRegistrations = (await fs.readdir(registrations)).toSorted();
  const beforeManifest = await fs.readFile(path.join(unrelated, "package.json"), "utf8");
  try {
    openOpenClawStateDatabase({ env: process.env });
    const run = await createUpdateRunAsync({ trigger: "cli" });
    expect(
      await prepareUpdate({
        runId: run.runId,
        runningRoot: target.checkout,
        runningVersion: VERSION,
        channel: "dev",
        node,
      }),
    ).toMatchObject({ status: "failed", reason: "release-check-failed" });
    expect(await getUpdateRunAsync(run.runId)).toMatchObject({
      status: "failed",
      phase: "finished",
      reason: "release-check-failed",
      steps: expect.arrayContaining([
        expect.objectContaining({ step: "prepare:build", status: "completed" }),
        expect.objectContaining({ step: "candidate-release-check", status: "failed" }),
      ]),
    });
    expect(await readTrial()).toBeNull();
    expect(await fs.readdir(path.join(resolvePrefix(), "releases"))).toEqual([]);
    expect((await git("worktree", "list", "--porcelain")).stdout).toBe(before);
    expect((await fs.readdir(registrations)).toSorted()).toEqual(beforeRegistrations);
    expect(await fs.readFile(path.join(unrelated, "package.json"), "utf8")).toBe(beforeManifest);
    expect((await git("status", "--porcelain")).stdout).toBe("");
  } finally {
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
  }
});

it("records one failed terminal run when preparation lock acquisition throws", async () => {
  vi.stubEnv("OPENCLAW_STATE_DIR", path.join(root, "state"));
  try {
    openOpenClawStateDatabase({ env: process.env });
    const run = await createUpdateRunAsync({ trigger: "cli" });
    vi.spyOn(fs, "link").mockRejectedValue(new Error("preparation lock failed"));
    expect(
      await prepareUpdate({
        runId: run.runId,
        runningRoot: root,
        runningVersion: VERSION,
        channel: "dev",
      }),
    ).toMatchObject({ status: "failed" });
    expect(await listUpdateRunsAsync()).toEqual([
      expect.objectContaining({ runId: run.runId, status: "failed", phase: "finished" }),
    ]);
    expect(await readTrial()).toBeNull();
  } finally {
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
  }
});

it("does not publish a trial when preparation outcome bookkeeping throws", async () => {
  vi.stubEnv("OPENCLAW_STATE_DIR", path.join(root, "state"));
  const { checkout } = await repository(false, ">=1", true);
  const recordPhase = updateWrites.recordUpdateRunPhaseAsync;
  vi.spyOn(updateWrites, "recordUpdateRunPhaseAsync").mockImplementation((id, phase, ...rest) =>
    phase === "activating"
      ? Promise.reject(new Error("preparation outcome bookkeeping failed"))
      : recordPhase(id, phase, ...rest),
  );
  try {
    openOpenClawStateDatabase({ env: process.env });
    const run = await createUpdateRunAsync({ trigger: "cli" });
    expect(
      await prepareUpdate({
        runId: run.runId,
        runningRoot: checkout,
        runningVersion: VERSION,
        channel: "dev",
        node,
      }),
    ).toMatchObject({ status: "failed" });
    expect(await getUpdateRunAsync(run.runId)).toMatchObject({
      status: "failed",
      phase: "finished",
      steps: expect.arrayContaining([
        expect.objectContaining({
          step: "outcome",
          status: "failed",
          detail: expect.stringContaining("preparation outcome bookkeeping failed"),
        }),
      ]),
    });
    expect(await readTrial()).toBeNull();
  } finally {
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
  }
});

it("refuses a trial published before the preparation lock is acquired", async () => {
  vi.stubEnv("OPENCLAW_STATE_DIR", path.join(root, "state"));
  try {
    openOpenClawStateDatabase({ env: process.env });
    const trialRun = await createUpdateRunAsync({ trigger: "cli" });
    const preparingRun = await createUpdateRunAsync({ trigger: "cli" });
    const link = fs.link;
    vi.spyOn(fs, "link").mockImplementationOnce(async (source, destination) => {
      await createTrialPending({
        runId: trialRun.runId,
        target: "releases/new/openclaw",
        previous: "releases/old/openclaw",
        version: VERSION,
      });
      return await link(source, destination);
    });
    expect(
      await prepareUpdate({
        runId: preparingRun.runId,
        runningRoot: root,
        runningVersion: VERSION,
        channel: "dev",
      }),
    ).toMatchObject({
      status: "failed",
      reason: "update-running",
      message: expect.stringContaining("Another update is switching releases"),
    });
    expect(await readTrial()).toMatchObject({ runId: trialRun.runId, phase: "pending" });
  } finally {
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
  }
});

it("retires all foreign unfinished runs while preserving the serving trial's handoff", async () => {
  vi.stubEnv("HOME", root);
  vi.stubEnv("OPENCLAW_STATE_DIR", path.join(root, "state"));
  const { checkout } = await repository();
  const target = vi
    .spyOn(targets, "resolveTarget")
    .mockRejectedValue(new Error("admission observed"));
  try {
    openOpenClawStateDatabase({ env: process.env });
    const foreign = [];
    for (let i = 0; i < 101; i++) {
      foreign.push(await createUpdateRunAsync({ trigger: "cli" }));
    }
    const handedOver = await createUpdateRunAsync({ trigger: "cli" });
    const prefix = resolvePrefix();
    const trial = await createTrialPending(
      {
        runId: handedOver.runId,
        target: path.relative(prefix, checkout),
        previous: path.relative(prefix, checkout),
        version: VERSION,
      },
      prefix,
    );
    const committed = {
      ...trial,
      phase: "committed" as const,
      reported: true,
      outcome: { status: "succeeded" as const, at: Date.now() },
    };
    await writeTrial(committed, prefix);
    await switchLink(path.relative(prefix, checkout), prefix);
    const run = await createUpdateRunAsync({ trigger: "cli" });
    expect(
      await withArtifactPreservingStateReads(() =>
        withOpenClawStateDatabaseReadSnapshot(
          async () => {
            await listUpdateRunsAsync({ active: true });
            return prepareUpdate({
              runId: run.runId,
              runningRoot: checkout,
              runningVersion: VERSION,
              channel: "dev",
              node,
            });
          },
          { env: process.env },
        ),
      ),
    ).toMatchObject({ status: "failed", reason: "no-target" });
    expect(target).toHaveBeenCalledOnce();
    expect(await listUpdateRunsAsync({ active: true })).toMatchObject([
      { runId: handedOver.runId, status: "running" },
    ]);
    for (const interrupted of [foreign[0]!, foreign.at(-1)!]) {
      expect(await getUpdateRunAsync(interrupted.runId)).toMatchObject({
        status: "failed",
        reason: "interrupted",
      });
    }
    expect(await readTrial(prefix)).toEqual(committed);
  } finally {
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
  }
});

it.each([
  "live-lease",
  ...(process.platform === "win32" ? [] : (["readable-idle-lease"] as const)),
  "restore-directory",
] as const)("preserves foreign runs during slot admission with %s", async (guard) => {
  vi.stubEnv("HOME", root);
  vi.stubEnv("OPENCLAW_STATE_DIR", path.join(root, "state"));
  const { checkout } = await repository();
  const target = vi
    .spyOn(targets, "resolveTarget")
    .mockRejectedValue(new Error("must not reach staging"));
  let lease: ManagedHandoffLease | undefined;
  let store: Awaited<ReturnType<typeof prepareManagedHandoffLeaseStore>> | undefined;
  try {
    const state = openOpenClawStateDatabase({ env: process.env });
    const foreign = await createUpdateRunAsync({ trigger: "cli" });
    const run = await createUpdateRunAsync({ trigger: "cli" });
    if (guard === "restore-directory") {
      await fs.mkdir(path.join(path.dirname(state.path), ".openclaw-restore-fixture"));
    } else {
      store = await prepareManagedHandoffLeaseStore({
        databasePath: resolveManagedUpdateLeaseDatabasePath(),
        serviceManagerEnv: resolveServiceManagerEnv(),
      });
      if (guard === "readable-idle-lease") {
        const databasePath = resolveManagedUpdateLeaseDatabasePath();
        const acquired = store.acquire(resolveUpdateInstallRoot(checkout), "idle-updater", {
          kind: "update",
        });
        if (acquired.kind !== "acquired") {
          throw new Error("The fixture did not initialize its in-place lease store");
        }
        expect(store.release(acquired.lease)).toBe(true);
        await fs.chmod(databasePath, 0o644);
        await expect(checkUpdateInstallationSlot(checkout, process.env)).resolves.toBeUndefined();
        expect((await fs.stat(databasePath)).mode & 0o777).toBe(0o600);
        expect(target).not.toHaveBeenCalled();
        expect(await getUpdateRunAsync(foreign.runId)).toMatchObject({ status: "running" });
        return;
      }
      const acquired = store.acquire(resolveUpdateInstallRoot(checkout), "live-updater", {
        kind: "update",
      });
      if (acquired.kind !== "acquired") {
        throw new Error("The fixture did not acquire its live in-place lease");
      }
      lease = acquired.lease;
    }
    expect(
      await prepareUpdate({
        runId: run.runId,
        runningRoot: checkout,
        runningVersion: VERSION,
        channel: "dev",
        node,
      }),
    ).toMatchObject({ status: "failed" });
    expect(target).not.toHaveBeenCalled();
    expect(await getUpdateRunAsync(foreign.runId)).toMatchObject({ status: "running" });
    expect(
      (await getUpdateRunAsync(run.runId))?.steps.find((step) => step.step === "outcome")?.detail,
    ).toContain(
      guard === "live-lease"
        ? "An in-place updater is still using this installation"
        : "Interrupted shared-database publication",
    );
  } finally {
    if (store && lease) {
      expect(store.release(lease)).toBe(true);
    }
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
  }
});
