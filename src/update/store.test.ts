import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { acquirePackageReleaseLease } from "../infra/package-release-lease.js";
import * as holders from "../infra/release-holder-inspection.js";
import * as ledger from "../infra/update-run-reader.js";
import { createUpdateRunRecordFixture } from "../infra/update-run-record.test-support.js";
import * as installation from "./installation-identity.js";
import {
  acquireUpdateLock,
  allocateStaging,
  collectReleases,
  createTrialPending,
  publishStaging,
  readUpdateLock,
  releaseUpdateLock,
  switchLink,
  writeTrial,
} from "./store.js";

const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const dir of directories.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
async function prefix() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-store-"));
  directories.push(dir);
  return dir;
}

it("admits one live prepare owner and reclaims a dead PID or an expired deadline", async () => {
  const dir = await prefix();
  const input = { runId: "first", pid: process.pid, deadlineMs: 60_000 };
  expect((await acquireUpdateLock(input, dir)).acquired).toBe(true);
  expect((await acquireUpdateLock({ ...input, runId: "second" }, dir)).acquired).toBe(false);
  expect(await readUpdateLock(dir)).toMatchObject({ runId: "first", dead: false });
  await releaseUpdateLock(dir);

  const owner = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
  await once(owner, "exit");
  expect(owner.pid).toBeTypeOf("number");
  await acquireUpdateLock({ ...input, runId: "dead-pid", pid: owner.pid! }, dir);
  expect(await readUpdateLock(dir)).toMatchObject({ dead: true });
  expect(await acquireUpdateLock({ ...input, runId: "replacement" }, dir)).toMatchObject({
    acquired: true,
    previous: { runId: "dead-pid" },
  });
  await releaseUpdateLock(dir);

  await acquireUpdateLock({ ...input, runId: "expired", deadlineMs: -1 }, dir);
  expect(await readUpdateLock(dir)).toMatchObject({ pid: process.pid, dead: true });
  expect(await acquireUpdateLock({ ...input, runId: "after-deadline" }, dir)).toMatchObject({
    acquired: true,
    previous: { runId: "expired" },
  });
});

it("publishes the prepared tree by rename and admits no overlapping trial", async () => {
  const dir = await prefix();
  const stage = await allocateStaging({ kind: "package", id: "candidate" }, dir);
  await fs.mkdir(stage.releaseRoot, { recursive: true });
  expect(stage.releaseRoot).toBe(
    path.join(dir, "releases", `.staging-${process.pid}-candidate`, "openclaw"),
  );
  await fs.writeFile(path.join(stage.releaseRoot, "package.json"), '{"version":"2.0.0"}');
  const stagedPath = stage.path;
  const releaseRoot = await publishStaging(stage);
  expect(releaseRoot).toBe(path.join(dir, "releases", "candidate", "openclaw"));
  expect(await fs.readFile(path.join(releaseRoot, "package.json"), "utf8")).toContain('"2.0.0"');
  await expect(fs.stat(stagedPath)).rejects.toMatchObject({ code: "ENOENT" });
  const input = {
    runId: "trial",
    target: path.relative(dir, releaseRoot),
    previous: "releases/old/openclaw",
    version: "2.0.0",
  };
  const trial = await createTrialPending(input, dir);
  for (const phase of ["pending", "trial", "restoring"] as const) {
    await writeTrial({ ...trial, phase }, dir);
    await expect(createTrialPending(input, dir)).rejects.toThrow("already");
  }
  await writeTrial({ ...trial, phase: "committed" }, dir);
  expect(await createTrialPending({ ...input, runId: "next" }, dir)).toMatchObject({
    phase: "pending",
    runId: "next",
    attempts: 0,
  });
});

it("collects frequent resident releases without removing live, trial, run or unrelated trees", async () => {
  const dir = await fs.realpath(await prefix());
  const releases = path.join(dir, "releases");
  const [selected, previous, leased, running, named, gateway] = [
    randomUUID(),
    randomUUID(),
    randomUUID(),
    randomUUID(),
    randomUUID(),
    randomUUID(),
  ];
  const root = (id: string) => path.join(releases, id, "openclaw");
  const ids = [
    selected,
    previous,
    leased,
    running,
    named,
    gateway,
    ...Array.from({ length: 15 }, () => randomUUID()),
  ];
  for (const id of [...ids, "operator-directory"]) {
    await fs.mkdir(root(id), { recursive: true });
    await fs.writeFile(path.join(root(id), "package.json"), JSON.stringify({ name: "openclaw" }));
  }
  await switchLink(root(leased), dir);
  vi.spyOn(installation, "readUpdateGatewayRoot").mockResolvedValue({
    pid: 123,
    root: root(gateway),
  });
  await switchLink(root(selected), dir);
  // A CLI started from the old root can outlive the preparation lock and link switch.
  const releaseLease = acquirePackageReleaseLease(root(leased), dir);
  const trial = await createTrialPending(
    { runId: randomUUID(), target: root(selected), previous: root(previous), version: "1.0.0" },
    dir,
  );
  const identity = { version: null, build: null, identity: "1:2" };
  vi.spyOn(ledger, "getUpdateRunForProgressAsync").mockImplementation(async (id) =>
    createUpdateRunRecordFixture(id, { status: "succeeded" }),
  );
  vi.spyOn(ledger, "listUpdateRunsAsync").mockResolvedValue([
    createUpdateRunRecordFixture(randomUUID(), {
      status: "running",
      finishedAtMs: null,
      origin: {
        packageRelease: {
          slot: path.join(dir, "openclaw"),
          from: { ...identity, path: root(named) },
          to: { ...identity, path: root(selected) },
        },
      },
    }),
  ]);
  try {
    const unrelated = randomUUID();
    await fs.mkdir(root(unrelated), { recursive: true });
    await fs.utimes(path.dirname(root(previous)), 0, 0); // Legacy records have no phase; age alone cannot retire their fallback.
    for (const record of [
      trial,
      { ...trial, phase: "committed" },
      { target: trial.target, previous: trial.previous, attempts: 0 },
    ]) {
      await fs.writeFile(path.join(releases, ".trial"), JSON.stringify(record));
      await collectReleases(dir, root(running));
      expect((await fs.readdir(releases)).filter((id) => !id.startsWith(".")).toSorted()).toEqual(
        [
          selected,
          previous,
          leased,
          running,
          named,
          gateway,
          "operator-directory",
          unrelated,
        ].toSorted(),
      );
    }
    await writeTrial(
      { ...trial, phase: "committed", reported: true, outcome: { status: "succeeded", at: 1 } },
      dir,
    );
    expect((await collectReleases(dir, root(running))).removed).toEqual([
      path.dirname(root(previous)),
    ]);
  } finally {
    releaseLease();
  }
});

it("collects releases with independent IDs only after verifying their own trial run and build", async () => {
  const dir = await fs.realpath(await prefix());
  const releases = path.join(dir, "releases");
  const history = new Map<string, ReturnType<typeof createUpdateRunRecordFixture>>();
  const release = async (status: "succeeded" | "failed" | "running", mismatch = false) => {
    const directory = path.join(releases, randomUUID());
    const root = path.join(directory, "openclaw");
    const runId = randomUUID(); // Prior resident preparers did not use their run ID as the release ID.
    const buildId = randomUUID();
    await fs.mkdir(path.join(root, "dist"), { recursive: true });
    await fs.writeFile(path.join(root, "package.json"), '{"name":"openclaw","version":"1.0.0"}');
    await fs.writeFile(path.join(root, "dist/build-info.json"), JSON.stringify({ buildId }));
    await fs.writeFile(
      path.join(directory, ".restore"),
      JSON.stringify({ v: 1, runId, files: [] }),
    );
    history.set(
      runId,
      createUpdateRunRecordFixture(runId, {
        status,
        after: { buildId },
        verification: {
          booted: true,
          versionMatch: true,
          runningBuildId: mismatch ? randomUUID() : buildId,
        },
      }),
    );
    return root;
  };
  const selected = await release("succeeded");
  const previous = await release("succeeded");
  const disposable = await release("succeeded");
  const aged = await release("succeeded");
  const ambiguous = await release("succeeded", true);
  const failed = await release("failed");
  const open = await release("running");
  await switchLink(selected, dir);
  vi.spyOn(ledger, "listUpdateRunsAsync").mockResolvedValue(
    [...history.values()].filter((run) => run.status === "running"),
  );
  vi.spyOn(ledger, "getUpdateRunForProgressAsync").mockImplementation(async (id) =>
    history.get(id),
  );
  vi.spyOn(installation, "readUpdateGatewayRoot").mockResolvedValue(undefined);
  await fs.utimes(path.dirname(aged), 0, 0);
  // Without a trial, preserve the old grace but still collect known releases after 24 hours.
  expect((await collectReleases(dir, selected)).removed).toEqual([path.dirname(aged)]);
  await createTrialPending(
    { runId: randomUUID(), target: selected, previous, version: "1.0.0" },
    dir,
  );
  expect((await collectReleases(dir, selected)).removed).toEqual([path.dirname(disposable)]);
  for (const root of [selected, previous, open, ambiguous, failed]) {
    expect((await fs.stat(root)).isDirectory()).toBe(true);
  }
});

it("reclaims an abandoned stage only after its owner exits and the worker excludes surviving work", async () => {
  const dir = await fs.realpath(await prefix());
  const live = await allocateStaging({}, dir);
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  await once(child, "exit");
  const abandoned = path.join(path.dirname(live.path), `.staging-${child.pid}-${randomUUID()}`);
  // The same dead run may also have been killed just after publishing the first candidate.
  const interrupted = randomUUID();
  const published = await allocateStaging({ id: interrupted }, dir);
  await fs.mkdir(published.releaseRoot);
  await fs.writeFile(
    path.join(published.releaseRoot, "package.json"),
    JSON.stringify({ name: "openclaw" }),
  );
  await publishStaging(published);
  const previous = { runId: interrupted, pid: child.pid!, startedAt: 1, deadlineMs: 1 };
  await fs.mkdir(abandoned);
  await fs.writeFile(path.join(abandoned, "part"), "12345");
  vi.spyOn(ledger, "listUpdateRunsAsync").mockResolvedValue([]);
  vi.spyOn(ledger, "getUpdateRunForProgressAsync").mockResolvedValue(
    createUpdateRunRecordFixture(interrupted, { status: "running" }),
  );
  const inspect = vi
    .spyOn(holders, "inspectReleaseHolders")
    .mockResolvedValue({ [abandoned]: "unknown" });
  expect((await collectReleases(dir, dir)).warnings[0]).toContain("5 logical bytes");
  expect(inspect).toHaveBeenCalledTimes(1);
  inspect.mockResolvedValue({ [abandoned]: "held" });
  expect((await collectReleases(dir, dir)).removed).toEqual([]);
  inspect.mockResolvedValue({ [abandoned]: "clear", [published.path]: "clear" });
  expect((await collectReleases(dir, dir, process.env, previous)).removed.toSorted()).toEqual(
    [abandoned, published.path].toSorted(),
  );
  expect(await fs.readdir(path.dirname(live.path))).toEqual([path.basename(live.path)]);
  expect(inspect.mock.lastCall?.[0].map(({ directory }) => directory).toSorted()).toEqual(
    [abandoned, published.path].toSorted(),
  );
});

it("collects a rolled-back first candidate without touching its external fallback or a live CLI", async () => {
  const dir = await fs.realpath(await prefix());
  const fallback = path.join(dir, "checkout");
  await fs.mkdir(fallback);
  const stage = await allocateStaging({}, dir);
  await fs.mkdir(stage.releaseRoot);
  await fs.writeFile(
    path.join(stage.releaseRoot, "package.json"),
    JSON.stringify({ name: "openclaw" }),
  );
  const candidate = await publishStaging(stage);
  await switchLink(fallback, dir);
  const trial = await createTrialPending(
    {
      runId: stage.id,
      target: path.relative(dir, candidate),
      previous: fallback,
      version: "1.0.0",
    },
    dir,
  );
  await writeTrial(
    {
      ...trial,
      phase: "rolled-back",
      reported: true,
      outcome: { status: "rolled-back", at: Date.now() },
    },
    dir,
  );
  vi.spyOn(ledger, "listUpdateRunsAsync").mockResolvedValue([]);
  vi.spyOn(installation, "readUpdateGatewayRoot").mockResolvedValue({
    pid: process.pid,
    root: fallback,
  });
  const census = vi
    .spyOn(holders, "inspectReleaseHolders")
    .mockResolvedValue({ [stage.path]: "held" });
  expect((await collectReleases(dir, fallback)).removed).toEqual([]);
  // Two later activations replace .trial and the external fallback. Neither releases a survivor.
  vi.spyOn(ledger, "getUpdateRunForProgressAsync").mockResolvedValue(
    createUpdateRunRecordFixture(stage.id, { status: "failed" }),
  );
  let previous = fallback;
  for (let n = 0; n < 2; n++) {
    const next = await allocateStaging({}, dir);
    await fs.mkdir(next.releaseRoot);
    await fs.writeFile(path.join(next.releaseRoot, "package.json"), '{"name":"openclaw"}');
    const target = await publishStaging(next);
    await switchLink(target, dir);
    await writeTrial(
      {
        ...trial,
        runId: next.id,
        target,
        previous,
        phase: "committed",
        reported: true,
        outcome: { status: "succeeded", at: Date.now() },
      },
      dir,
    );
    expect((await collectReleases(dir, fallback)).removed).not.toContain(stage.path);
    expect(census).toHaveBeenNthCalledWith(n + 2, [{ runId: stage.id, directory: stage.path }]);
    expect((await fs.stat(candidate)).isDirectory()).toBe(true);
    previous = target;
  }
  census.mockResolvedValue({ [stage.path]: "clear" });
  expect((await collectReleases(dir, fallback)).removed).toEqual([stage.path]);
  expect(await fs.realpath(path.join(dir, "openclaw"))).toBe(previous);
});
