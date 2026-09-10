import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  createVitestResourceOwner,
  findVitestResourceOwner,
} from "../../scripts/lib/vitest-resource-ownership.mts";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import { isPidAlive } from "../shared/pid-alive.js";
import { resolvePackageActivationAnchor } from "./package-update-activation-journal.js";
import {
  startActivationProcess,
  type ActivationFault,
} from "./package-update-activation-process-owner.test-support.js";
import {
  activationCommand,
  activationSourceArgs,
  createActivationFixture,
  startActivationHelper,
  type ActivationFixture,
} from "./package-update-activation.process.test-support.js";

const tempDirs = createTempDirTracker();
const commandOwners = new Map<
  ReturnType<typeof createVitestResourceOwner>,
  (() => void) | undefined
>();
// This file stays in source; the support module is relocated by the invocation compiler.
const preload = fileURLToPath(
  new URL("../../test/fixtures/package-update-activation-preload.mjs", import.meta.url),
);
type RunningProcess = ReturnType<typeof startActivationProcess>;
const processes: RunningProcess[] = [];

afterEach(async () => {
  const errors: unknown[] = [];
  for (const child of [...processes].toReversed()) {
    try {
      await child.cleanup();
      processes.splice(processes.indexOf(child), 1);
    } catch (error) {
      errors.push(error);
    }
  }
  for (const owner of commandOwners.keys()) {
    try {
      owner.assertReleased();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length) {
    throw new AggregateError(errors, "Fixture owners remain unsettled");
  }
  tempDirs.cleanup();
  for (const [owner, release] of commandOwners) {
    release?.();
    commandOwners.delete(owner);
  }
});

function makeFixtureRoot(prefix: string) {
  const base = tempDirs.make(prefix);
  // Detached command claims survive compiled updater death. Parent teardown
  // requires their positive release receipts before removing any fixture data.
  const release = findVitestResourceOwner(base)?.claim();
  // Retain the enclosing Vitest namespace too if this worker dies before teardown.
  commandOwners.set(createVitestResourceOwner(base), release);
  return base;
}

function track(child: RunningProcess) {
  processes.push(child);
  return child;
}

async function fixture(
  target: Parameters<typeof createActivationFixture>[2] = "capable",
  receiver: Parameters<typeof createActivationFixture>[3] = "complete",
) {
  return await createActivationFixture(
    makeFixtureRoot("openclaw-activation-process-"),
    preload,
    target,
    receiver,
  );
}

function original(
  value: ActivationFixture,
  faults: ActivationFault[] = [],
  mode = "update",
  childFault?: Parameters<typeof startActivationProcess>[0]["childFault"],
) {
  return track(
    startActivationProcess({
      base: value.base,
      args: activationSourceArgs(value, mode),
      preload: value.preload,
      faults,
      ancestors: true,
      observeChildren: mode.startsWith("post-core"),
      childFault,
    }),
  );
}

async function helper(value: ActivationFixture, action: "status" | "repair" | "retire") {
  const child = track(
    startActivationHelper(value, resolvePackageActivationAnchor(value.packageRoot), action),
  );
  const result = await child.closed;
  expect(result.signal, result.stderr).toBeNull();
  return result;
}

async function selectedVersion(value: ActivationFixture) {
  const manifest = JSON.parse(
    await fs.readFile(path.join(value.packageRoot, "package.json"), "utf8"),
  ) as { version: string };
  return manifest.version;
}

async function assertCandidate(value: ActivationFixture) {
  expect(await selectedVersion(value)).toBe(value.afterVersion);
  for (const launcher of [value.launcher, value.secondLauncher]) {
    const result = await activationCommand(process.execPath, [launcher], value.base);
    expect(result.stdout).toContain(`:${value.afterVersion}\n`);
  }
  expect(await fs.readFile(value.sentinel, "utf8")).toBe("unrelated executable\n");
}

async function assertRetained(value: ActivationFixture) {
  const anchor = resolvePackageActivationAnchor(value.packageRoot);
  const retained = [];
  for (const entry of await fs.readdir(anchor, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    const manifest = await fs
      .readFile(path.join(anchor, entry.name, "package.json"), "utf8")
      .catch(() => null);
    if (manifest && (JSON.parse(manifest) as { version: string }).version === value.beforeVersion) {
      retained.push(path.join(anchor, entry.name));
    }
  }
  expect(retained).toHaveLength(1);
  return retained[0]!;
}

const publicationCuts = [
  { name: "displaced package with an absent canonical CLI", path: "packageRoot", argument: 0 },
  { name: "published package before acknowledgement", path: "packageRoot", argument: 1 },
  { name: "first launcher before remaining launcher publication", path: "launcher", argument: 1 },
  { name: "last launcher before acknowledgement", path: "secondLauncher", argument: 1 },
] as const;
const finalDeletionCuts = [
  { artifact: "recovery.mjs", operation: "unlink", when: "before", state: "resumable" },
  { artifact: "recovery.mjs", operation: "unlink", when: "after", state: "incomplete" },
  { artifact: "operation.sqlite", operation: "unlink", when: "before", state: "incomplete" },
  { artifact: "operation.sqlite", operation: "unlink", when: "after", state: "incomplete" },
  { artifact: "", operation: "rmdir", when: "before", state: "incomplete" },
  { artifact: "", operation: "rmdir", when: "after", state: "removed" },
] as const;

describe.runIf(process.platform !== "win32")("package activation process interruption", () => {
  it("bounds command timeout through descendant and inherited-output closure", async () => {
    const base = makeFixtureRoot("openclaw-activation-command-");
    await fs.mkdir(path.join(base, "tmp"));
    const pidFile = path.join(base, "owned-descendant.pid");
    await expect(
      activationCommand(
        process.execPath,
        [
          "-e",
          `const child = require("node:child_process").spawn(process.execPath, [
            "-e", 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);'
          ], { stdio: "inherit" });
          require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));
          setInterval(() => {}, 1000);`,
        ],
        base,
        500,
      ),
    ).rejects.toMatchObject({ code: "ETIMEDOUT" });
    expect(isPidAlive(Number(await fs.readFile(pidFile, "utf8")))).toBe(false);
  });

  it.each(["complete", "descendant"] as const)(
    "joins the real delegated post-core receiver and its %s work before returning",
    async (receiver) => {
      const value = await fixture("capable", receiver);
      const child = original(value, [], "post-core");
      const admitted = await child.event("receiver-admitted");
      expect(admitted.fenced).toBe(true);
      await child.event("post-core-returned");
      const receivers = child.events().filter((event) => event.event === "spawned" && event.fd3);
      expect(receivers).toHaveLength(1);
      expect(receivers[0]?.detached).toBe(true);
      for (const event of child
        .events()
        .filter((entry) => entry.event === "spawned" && entry.fd3 !== undefined)) {
        expect(isPidAlive(event.pid)).toBe(false);
      }
      await child.killAndJoin();
      expect((await helper(value, "repair")).code).toBe(0);
      expect((await helper(value, "retire")).code).toBe(0);
    },
  );

  it("refuses repair after the parent dies while its genuinely delegated child is alive", async () => {
    const value = await fixture("capable", "hold");
    const child = original(value, [], "post-core");
    const admitted = await child.event("receiver-ready");
    expect(admitted.fenced).toBe(true);
    expect(
      child.events().find((event) => event.event === "spawned" && event.pid === admitted.pid)?.fd3,
    ).toBe(true);
    for (const pid of child.pids().toReversed()) {
      if (pid !== admitted.pid) {
        await child.killPid(pid);
      }
    }
    const incumbent = await fs.lstat(value.packageRoot);
    expect((await helper(value, "repair")).code).not.toBe(0);
    expect(isPidAlive(admitted.pid)).toBe(true);
    expect((await fs.lstat(value.packageRoot)).ino).toBe(incumbent.ino);
    await child.killPid(admitted.pid);
    await child.joinProcesses();
    expect((await child.closed).signal).toBe("SIGKILL");
    expect((await helper(value, "repair")).code).toBe(0);
    expect((await helper(value, "retire")).code).toBe(0);
  });

  it.each(["spawn", "early-exit", "closed-pipe", "timeout"] as const)(
    "settles real post-core %s failure before rollback compensation",
    async (failure) => {
      const value = await fixture("capable", failure === "timeout" ? "hold" : "complete");
      const child = original(
        value,
        [],
        failure === "timeout" ? "post-core-timeout" : "post-core",
        failure === "timeout" ? undefined : failure,
      );
      if (failure === "timeout") {
        await child.event("receiver-ready");
      }
      await child.event("post-core-failed-settled");
      for (const event of child
        .events()
        .filter((entry) => entry.event === "spawned" && entry.fd3 !== undefined)) {
        expect(isPidAlive(event.pid)).toBe(false);
      }
      expect(await selectedVersion(value)).toBe(value.beforeVersion);
      await child.killAndJoin();
      expect((await helper(value, "repair")).code).not.toBe(0);
      expect((await helper(value, "retire")).code).toBe(0);
    },
  );

  it.each(["legacy", "respawn-only"] as const)(
    "keeps the %s target on the disclosed nonjournaled source-contract path",
    async (target) => {
      const value = await fixture(target);
      const child = original(
        value,
        [
          {
            label: "unsupported-target-displacement",
            operation: "rename",
            path: value.packageRoot,
            when: "before",
            action: "observe",
          },
        ],
        "post-core",
      );
      await child.event("post-core-returned");
      const output = child.output().stdout;
      const disclosure = output.indexOf("repair is unavailable for this target");
      expect(disclosure).toBeGreaterThanOrEqual(0);
      expect(disclosure).toBeLessThan(output.indexOf("unsupported-target-displacement"));
      expect(child.events().filter((entry) => entry.event === "spawned" && entry.fd3)).toEqual([]);
      expect(child.events().find((entry) => entry.event === "receiver-admitted")?.fenced).toBe(
        false,
      );
      await expect(
        fs.lstat(resolvePackageActivationAnchor(value.packageRoot)),
      ).rejects.toMatchObject({ code: "ENOENT" });
      await assertCandidate(value);
      await child.killAndJoin();
    },
  );

  it.each([false, true])(
    "accepts the tagged ENV-only parent only without pending publication (pending=%s)",
    async (pending) => {
      const value = await fixture();
      const owner = pending ? original(value, [], "retain") : undefined;
      if (owner) {
        await owner.event("update-returned");
      }
      const receiver = track(
        startActivationProcess({
          base: value.base,
          args: [path.join(value.packageRoot, "dist", "index.js")],
          env: {
            OPENCLAW_UPDATE_POST_CORE: "1",
            OPENCLAW_UPDATE_POST_CORE_CHANNEL: "stable",
            OPENCLAW_UPDATE_POST_CORE_STARTED_AT_MS: String(Date.now()),
            OPENCLAW_UPDATE_POST_CORE_RESULT_PATH: path.join(value.base, "legacy-result.json"),
          },
        }),
      );
      const result = await receiver.closed;
      expect(result.code === 0, result.stderr).toBe(!pending);
      if (pending) {
        await expect(fs.lstat(path.join(value.base, "receiver-mutation"))).rejects.toMatchObject({
          code: "ENOENT",
        });
        await owner!.killAndJoin();
        expect((await helper(value, "repair")).code).toBe(0);
        expect((await helper(value, "retire")).code).toBe(0);
      } else {
        expect(receiver.events().find((entry) => entry.event === "receiver-admitted")?.fenced).toBe(
          false,
        );
      }
    },
  );

  it.each(publicationCuts)(
    "repairs $name after SIGKILL of the updater and ancestors",
    async (cut) => {
      const value = await fixture();
      const beforeSecond = await fs.readlink(value.secondLauncher);
      const child = original(value, [
        {
          label: cut.name,
          operation: "rename",
          path: value[cut.path],
          argument: cut.argument,
          when: "after",
        },
      ]);
      await child.checkpoint(cut.name);
      const anchor = resolvePackageActivationAnchor(value.packageRoot);
      expect(child.output().stdout).toContain(`${path.join(anchor, "recovery.mjs")}' status`);
      if (cut.path === "packageRoot" && cut.argument === 0) {
        await expect(fs.stat(value.packageRoot)).rejects.toMatchObject({ code: "ENOENT" });
        await expect(
          activationCommand(process.execPath, [value.launcher], value.base),
        ).rejects.toThrow();
      }
      if (cut.path === "launcher") {
        expect(await fs.readlink(value.secondLauncher)).toBe(beforeSecond);
        expect(await fs.readlink(value.launcher)).toContain(value.afterVersion);
      }
      await child.killAndJoin();

      expect((await helper(value, "status")).code).toBe(0);
      const repaired = await helper(value, "repair");
      expect(repaired.code, repaired.stderr).toBe(0);
      expect(repaired.stdout).toContain("publication-complete");
      if (cut.path === "packageRoot" && cut.argument === 0) {
        expect(repaired.stderr).toContain("may republish the recorded candidate");
      }
      await assertCandidate(value);
      await assertRetained(value);
      const launcher = await fs.lstat(value.launcher);
      expect((await helper(value, "repair")).code).toBe(0);
      expect((await fs.lstat(value.launcher)).ino).toBe(launcher.ino);
      expect((await helper(value, "retire")).code).toBe(0);
      await expect(fs.lstat(anchor)).rejects.toMatchObject({ code: "ENOENT" });
      await assertCandidate(value);
    },
  );

  it("aborts an untouched prepared operation without replacing its incumbent", async () => {
    const value = await fixture();
    const incumbent = await fs.lstat(value.packageRoot);
    const child = original(value, [
      {
        label: "before-displacement",
        operation: "rename",
        path: value.packageRoot,
        when: "before",
      },
    ]);
    await child.checkpoint("before-displacement");
    await child.killAndJoin();
    const repaired = await helper(value, "repair");
    expect(repaired.code, repaired.stderr).toBe(0);
    expect(repaired.stdout).toContain("aborted");
    expect(await selectedVersion(value)).toBe(value.beforeVersion);
    expect((await fs.lstat(value.packageRoot)).ino).toBe(incumbent.ino);
    expect((await helper(value, "retire")).code).toBe(0);
  });

  it("resumes after the first repair owner dies following a real package rename", async () => {
    const value = await fixture();
    const child = original(value, [
      {
        label: "displaced",
        operation: "rename",
        path: value.packageRoot,
        when: "after",
      },
    ]);
    await child.checkpoint("displaced");
    await child.killAndJoin();
    const repair = track(
      startActivationHelper(value, resolvePackageActivationAnchor(value.packageRoot), "repair", [
        {
          label: "repair-published",
          operation: "rename",
          path: value.packageRoot,
          argument: 1,
          when: "after",
        },
      ]),
    );
    await repair.checkpoint("repair-published");
    expect(await selectedVersion(value)).toBe(value.afterVersion);
    await repair.killAndJoin();
    expect((await helper(value, "repair")).code).toBe(0);
    await assertCandidate(value);
    await assertRetained(value);
    expect((await helper(value, "retire")).code).toBe(0);
  });

  it("keeps recovery assets after the updater's staging finally has completed", async () => {
    const value = await fixture();
    const child = original(value, [], "retain");
    await child.event("update-returned");
    expect(
      (await fs.readdir(value.globalRoot)).filter((entry) =>
        entry.startsWith(".openclaw.update-stage-"),
      ),
    ).toEqual([]);
    await child.killAndJoin();
    expect((await helper(value, "repair")).code).toBe(0);
    await assertCandidate(value);
    await assertRetained(value);
    expect((await helper(value, "retire")).code).toBe(0);
  });

  it.each(["retained transaction", "activation error"])(
    "disarms forward repair before the first %s compensation",
    async (reason) => {
      const value = await fixture();
      const faults: ActivationFault[] =
        reason === "activation error"
          ? [
              {
                label: "publication-error-after-effect",
                operation: "rename",
                path: value.packageRoot,
                argument: 1,
                when: "after",
                action: "error",
              },
            ]
          : [];
      faults.push({
        label: "rollback-before-compensation",
        operation: "rename",
        path: value.packageRoot,
        occurrence: reason === "activation error" ? 1 : 2,
        when: "before",
      });
      const child = original(value, faults, reason === "activation error" ? "update" : "rollback");
      await child.checkpoint("rollback-before-compensation");
      const status = await helper(value, "status");
      expect(status.stdout).toContain("rollback-in-progress");
      await child.killAndJoin();
      const before = await fs.lstat(value.packageRoot);
      const refused = await helper(value, "repair");
      expect(refused.code).not.toBe(0);
      expect(`${refused.stdout}\n${refused.stderr}`).toMatch(/disarmed|rollback/u);
      expect((await fs.lstat(value.packageRoot)).ino).toBe(before.ino);
    },
  );

  it("resumes retirement after a real deletion while retaining the helper until last", async () => {
    const value = await fixture();
    const child = original(value, [], "retain");
    await child.event("update-returned");
    await child.killAndJoin();
    const previous = await assertRetained(value);
    const anchor = resolvePackageActivationAnchor(value.packageRoot);
    const retirement = track(
      startActivationHelper(value, anchor, "retire", [
        {
          label: "retirement-deleted-file",
          operation: "remove",
          path: previous,
          descendants: true,
          when: "after",
        },
      ]),
    );
    await retirement.checkpoint("retirement-deleted-file");
    expect((await fs.lstat(path.join(anchor, "recovery.mjs"))).isFile()).toBe(true);
    await retirement.killAndJoin();
    const resumed = await helper(value, "retire");
    expect(resumed.code, resumed.stderr).toBe(0);
    await expect(fs.lstat(anchor)).rejects.toMatchObject({ code: "ENOENT" });
    await assertCandidate(value);
  });

  it.each(finalDeletionCuts)(
    "keeps conservative admission $when $operation of '$artifact'",
    async (cut) => {
      const value = await fixture();
      const child = original(value, [], "retain");
      await child.event("update-returned");
      await child.killAndJoin();
      const anchor = resolvePackageActivationAnchor(value.packageRoot);
      const retirement = track(
        startActivationHelper(value, anchor, "retire", [
          {
            label: "final-deletion",
            operation: cut.operation,
            path: path.join(anchor, cut.artifact),
            when: cut.when,
          },
        ]),
      );
      await retirement.checkpoint("final-deletion");
      await retirement.killAndJoin();

      const admission = track(
        startActivationProcess({
          base: value.base,
          args: activationSourceArgs(value, "admission"),
        }),
      );
      const admitted = await admission.closed;
      expect(admitted.signal).toBeNull();
      if (cut.state === "resumable") {
        expect(admitted.code).not.toBe(0);
        expect(admitted.stderr).toMatch(/recovery.*pending|publication is incomplete/u);
        expect((await helper(value, "status")).code).toBe(0);
        const resumed = await helper(value, "retire");
        expect(resumed.code, resumed.stderr).toBe(0);
        await expect(fs.lstat(anchor)).rejects.toMatchObject({ code: "ENOENT" });
      } else if (cut.state === "incomplete") {
        expect(admitted.code).not.toBe(0);
        expect(admitted.stderr).toContain("operator inspection");
        expect(admitted.stderr).toContain("next mutable update is blocked");
        expect(admitted.stderr).not.toContain("recovery.mjs");
        expect((await fs.lstat(anchor)).isDirectory()).toBe(true);
        await expect(fs.lstat(path.join(anchor, "recovery.mjs"))).rejects.toMatchObject({
          code: "ENOENT",
        });
        const remaining = await fs.readdir(anchor);
        expect(remaining).toEqual(
          cut.artifact === "recovery.mjs" ||
            (cut.artifact === "operation.sqlite" && cut.when === "before")
            ? ["operation.sqlite"]
            : [],
        );
      } else {
        // Loss of the final acknowledgement does not make a removed helper rerunnable.
        expect(admitted.code, admitted.stderr).toBe(0);
        await expect(fs.lstat(anchor)).rejects.toMatchObject({ code: "ENOENT" });
      }
      await assertCandidate(value);
    },
  );

  it("does not remove unknown recovery evidence during retirement", async () => {
    const value = await fixture();
    const child = original(value, [], "retain");
    await child.event("update-returned");
    await child.killAndJoin();
    const anchor = resolvePackageActivationAnchor(value.packageRoot);
    const unknown = path.join(anchor, "unrelated-evidence");
    await fs.writeFile(unknown, "preserve this evidence\n", { mode: 0o600 });
    expect((await helper(value, "retire")).code).not.toBe(0);
    expect(await fs.readFile(unknown, "utf8")).toBe("preserve this evidence\n");
    expect((await fs.lstat(path.join(anchor, "recovery.mjs"))).isFile()).toBe(true);
  });

  it("keeps healthy automatic package and launcher cleanup unchanged", async () => {
    const value = await fixture();
    const child = original(value);
    await child.event("update-returned");
    await assertCandidate(value);
    expect(
      (await fs.readdir(value.globalRoot)).filter((entry) => entry.startsWith(".openclaw.")),
    ).toEqual([]);
    await child.killAndJoin();
  });
});
