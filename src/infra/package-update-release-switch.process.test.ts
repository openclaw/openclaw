import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  captureUpdateCommandExecutorAuthority,
  withUpdateCommandExecutor,
} from "../cli/update-cli/update-command-executor.js";
import { collectPackageReleases, listPackageReleases } from "./package-release-retention.js";
import { readPackageReleaseSlotSync } from "./package-release-slot-path.js";
import { capturePackageReleaseSlot, switchPackageReleaseLink } from "./package-release-slot.js";
import {
  openPackageActivationJournal,
  resolvePackageActivationAnchor,
  resolvePackageActivationJournalPath,
} from "./package-update-activation-journal.js";
import { createPackageActivationLifetimeFixture } from "./package-update-activation-lifetime.test-support.js";
import { packageActivationRuntimeEntrypoint } from "./package-update-activation-runtime-assets.js";
import {
  assertNoPendingPackageActivation,
  runPackageActivationRecovery,
} from "./package-update-activation.js";
import { stagePackageRelease } from "./package-update-release-switch.test-support.js";
import type { PackageUpdateTransaction } from "./package-update-swap-contract.js";
import { swapStagedPackageInstall } from "./package-update-swap.js";
import { expectedPathExchangeRoute } from "./path-exchange.test-support.js";
import { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "./runtime-worker-url.js";

const child = fileURLToPath(
  resolveRuntimeWorkerUrl({
    ...packageActivationRuntimeEntrypoint,
    sourceWorkerName: "package-update-release-switch.process.test-support",
    distWorkerPath: "infra/package-update-release-switch.process.test-support.js",
  }),
);

let dir: string;
beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-release-crash-")));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

type ChildEvent = {
  cut?: string;
  boundary?: number;
  label?: string;
  status?: string;
  detail?: string;
  rollback?: { exitCode: number | null; error?: string | null };
};
type Tools = "missing" | undefined;
type ChildEnv = (env: NodeJS.ProcessEnv) => NodeJS.ProcessEnv;

/** Run one installation in a child on its own prefix; `cut` says where it is killed. */
async function runSwitch(
  cut: string,
  layout: "linked" | "plain" | "swap" | "journal",
  options: { root?: string; tools?: Tools; verification?: "fails"; env?: ChildEnv } = {},
) {
  const root = options.root ?? dir;
  const packagePath = path.join(root, "prefix", "lib", "node_modules", "openclaw");
  let authority = "";
  if (layout === "journal") {
    // The child publishes under an executor that uses this test's private lease database.
    fs.mkdirSync(packagePath, { recursive: true });
    authority = JSON.stringify(
      await withUpdateCommandExecutor(randomUUID(), async (executor) =>
        captureUpdateCommandExecutorAuthority(await executor.enter(packagePath)),
      ),
    );
  }
  const proc = spawn(
    process.execPath,
    [
      ...resolveRuntimeWorkerArgv(pathToFileURL(child)),
      cut,
      root,
      layout,
      options.tools ?? "",
      options.verification ?? "",
      authority,
    ],
    {
      stdio: ["ignore", "pipe", "pipe"],
      env: options.env?.({ ...process.env, HOME: root, USERPROFILE: root }),
    },
  );
  let stdout = "";
  let stderr = "";
  proc.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
  proc.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
  const signal = await new Promise<NodeJS.Signals | null>((resolve) => {
    proc.on("close", (_code, closeSignal) => resolve(closeSignal));
  });
  const events = stdout
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as ChildEvent);
  // The child reports the cut it reached last, then dies there or exits.
  expect({ signal, stderr, cut: events.at(-1)?.cut }).toMatchObject({
    signal: cut === "complete" ? null : "SIGKILL",
    cut,
  });
  const prefix = path.join(root, "prefix");
  const globalRoot = path.join(prefix, "lib", "node_modules");
  return {
    events,
    root,
    prefix,
    slot: path.join(globalRoot, "openclaw"),
    globalRoot,
    previous: path.join(prefix, "releases", "r1", "lib", "node_modules", "openclaw"),
    candidate: fs.readFileSync(path.join(root, "candidate"), "utf8"),
    temporaryLinks: () =>
      fs.readdirSync(globalRoot).filter((name) => name.startsWith(".openclaw.release-link-")),
  };
}

const version = (root: string) =>
  JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;

/**
 * Replace a plain package directory once to the end, then once per boundary of
 * that run with the updater killed there. `installed` is the version the
 * package path serves afterwards, or null when it serves nothing.
 */
async function killAtEveryBoundary(
  layout: "plain" | "swap" | "journal",
  tools?: Tools,
  journal?: { root: string; env: ChildEnv },
) {
  const base = journal?.root ?? dir;
  const complete = await runSwitch("complete", layout, {
    root: path.join(base, "complete"),
    tools,
    env: journal?.env,
  });
  const labels = complete.events.flatMap((event) => event.label ?? []);
  const kill = async (label: string, index: number) => {
    const state = await runSwitch(`boundary:${index + 1}`, layout, {
      root: path.join(base, `killed-${index + 1}`),
      tools,
      env: journal?.env,
    });
    let installed: string | null = null;
    try {
      installed = version(state.slot);
    } catch {
      // The package path resolves to no package.
    }
    return { label, state, installed };
  };
  // Journaled runs share one lease database, whose file lock refuses a crowd.
  const killed: Array<Awaited<ReturnType<typeof kill>>> = [];
  if (journal) {
    for (const [index, label] of labels.entries()) {
      killed.push(await kill(label, index));
    }
  } else {
    killed.push(...(await Promise.all(labels.map(kill))));
  }
  // Every killed run died right after the boundary the completed run names at that position.
  expect(killed.map((run) => run.state.events.at(-2)?.label)).toEqual(labels);
  expect(complete.events.at(-1)?.status).toBe("committed");
  return { labels, killed, complete, detail: complete.events.at(-1)?.detail ?? "" };
}

/** The same sweep over the switch that adopts a plain package directory as a release. */
async function adoptAtEveryBoundary(tools?: Tools) {
  const sweep = await killAtEveryBoundary("plain", tools);
  const { complete } = sweep;
  // The completed run leaves the old tree as a release behind the switched link.
  const retained = fs
    .readdirSync(path.join(complete.prefix, "releases"))
    .filter((id) => id.startsWith("2026.11.3-"))
    .map((id) => path.join(complete.prefix, "releases", id, "lib", "node_modules", "openclaw"));
  expect(readPackageReleaseSlotSync(complete.slot)?.releaseRoot).toBe(complete.candidate);
  expect(retained.map(version)).toEqual(["2026.11.3"]);
  expect(fs.readdirSync(complete.globalRoot)).toEqual(["openclaw"]);
  return sweep;
}

describe.skipIf(process.platform === "win32")("release switch killed by SIGKILL", () => {
  it("before the temporary link: the old release stays selected and nothing is pending", async () => {
    const state = await runSwitch("before-temporary-link", "linked");
    expect(readPackageReleaseSlotSync(state.slot)?.releaseRoot).toBe(state.previous);
    expect(state.temporaryLinks()).toEqual([]);
    // The unselected candidate is left for collection, complete and untouched.
    expect(version(state.candidate)).toBe("2026.12.1");
  });

  it("after the temporary link and before the rename: the next switch removes the leftover", async () => {
    const state = await runSwitch("before-rename", "linked");
    expect(readPackageReleaseSlotSync(state.slot)?.releaseRoot).toBe(state.previous);
    expect(state.temporaryLinks()).toHaveLength(1);

    const capture = await capturePackageReleaseSlot(state.slot);
    if (capture.kind !== "link") {
      throw new Error("expected the old link");
    }
    await switchPackageReleaseLink({
      slot: state.slot,
      expected: capture,
      target: path.relative(state.globalRoot, state.candidate),
      assertCurrent: () => {},
    });
    expect(readPackageReleaseSlotSync(state.slot)?.releaseRoot).toBe(state.candidate);
    expect(state.temporaryLinks()).toEqual([]);
  });

  it("after the rename and before confirmation: the link names the complete candidate", async () => {
    const state = await runSwitch("after-rename", "linked");
    expect(readPackageReleaseSlotSync(state.slot)?.releaseRoot).toBe(state.candidate);
    expect(version(state.slot)).toBe("2026.12.1");
    expect(state.temporaryLinks()).toEqual([]);
    // The next run reads the link; rolling back repeats the switch with the old text.
    const capture = await capturePackageReleaseSlot(state.slot);
    if (capture.kind !== "link") {
      throw new Error("expected the candidate link");
    }
    await switchPackageReleaseLink({
      slot: state.slot,
      expected: capture,
      target: path.relative(state.globalRoot, state.previous),
      assertCurrent: () => {},
    });
    expect(version(state.slot)).toBe("2026.11.3");
  });

  it.runIf(expectedPathExchangeRoute)(
    "at every boundary of an adoption: the package path serves a complete package",
    async () => {
      const { labels, killed, detail } = await adoptAtEveryBoundary();

      expect(killed.filter((run) => run.installed === null).map((run) => run.label)).toEqual([]);
      // The old package serves until the link switch, the new one after it.
      const switched = labels.findLastIndex((label) => label.startsWith("rename "));
      expect(killed.map((run) => run.installed)).toEqual(
        labels.map((_, index) => (index < switched ? "2026.11.3" : "2026.12.1")),
      );
      // The sweep cut on both sides of the exchange tool, which is what adopted the directory.
      expect(labels.filter((label) => /^(start|end) /u.test(label))).toHaveLength(2);
      expect(detail).toContain(`by an atomic exchange (${expectedPathExchangeRoute})`);
    },
  );

  it("without an exchange tool: only the instant between the two renames has no package", async () => {
    const { killed, detail } = await adoptAtEveryBoundary("missing");
    expect(detail).toMatch(/two renames \(atomic exchange unavailable: .*ENOENT/u);

    const broken = killed.filter((run) => run.installed === null);
    expect(broken.map((run) => run.label)).toEqual([
      "rename lib/node_modules/openclaw -> releases/2026.11.3/lib/node_modules/openclaw",
    ]);
    const state = broken[0]!.state;
    expect(fs.lstatSync(state.slot, { throwIfNoEntry: false })).toBeUndefined();
    const [leftover] = state.temporaryLinks();
    expect(leftover).toBeDefined();
    // The documented recovery: rename the leftover link onto the package path.
    fs.renameSync(path.join(state.globalRoot, leftover!), state.slot);
    expect(readPackageReleaseSlotSync(state.slot)).not.toBeNull();
    expect(version(state.slot)).toBe("2026.11.3");
    expect(fs.readlinkSync(path.join(state.prefix, "bin", "openclaw"))).toBe(
      "../lib/node_modules/openclaw/openclaw.mjs",
    );
  });

  it("before the exchange: the next update adopts again and collection removes the leftover", async () => {
    // Killed with the link for the package path already waiting in the release.
    const state = await runSwitch("after-waiting-link", "plain");
    const releases = path.join(state.prefix, "releases");
    const leftover = fs.readdirSync(releases).find((id) => id.startsWith("2026.11.3-"))!;
    const waiting = path.join(releases, leftover, "lib", "node_modules", "openclaw");
    expect(fs.lstatSync(waiting).isSymbolicLink()).toBe(true);
    expect(fs.existsSync(waiting)).toBe(false);
    expect(version(state.slot)).toBe("2026.11.3");

    const next = await stagePackageRelease(
      { prefix: state.prefix, globalRoot: state.globalRoot, slot: state.slot },
      "2026.12.2",
    );
    const result = await swapStagedPackageInstall({ ...next, onTransaction: () => {} });

    expect(result.status).toBe("committed");
    expect(version(state.slot)).toBe("2026.12.2");
    // `openclaw update status` lists releases; the leftover and its dangling link are not one.
    const listed = await listPackageReleases(state.slot);
    expect(new Set(listed.map((release) => release.version))).toEqual(
      new Set(["2026.11.3", "2026.12.1", "2026.12.2"]),
    );
    expect(listed.map((release) => release.id)).not.toContain(leftover);
    const collected = await collectPackageReleases({
      slot: state.slot,
      prefix: state.prefix,
      readOpenRuns: async () => [],
      now: Date.now() + 2 * 24 * 60 * 60 * 1000,
    });
    expect(collected.warnings).toEqual([]);
    expect(collected.removed).toContain(path.join(releases, leftover));
    expect(fs.existsSync(path.join(releases, leftover))).toBe(false);
  });
});

describe.skipIf(process.platform === "win32")("package swap killed by SIGKILL", () => {
  const backups = (globalRoot: string) =>
    fs
      .readdirSync(globalRoot)
      .filter((name) => name.startsWith(".openclaw.package-backup-"))
      .map((name) => path.join(globalRoot, name));
  const launcherTarget = (prefix: string) => fs.realpathSync(path.join(prefix, "bin", "openclaw"));

  it.runIf(expectedPathExchangeRoute)(
    "at every boundary: the package path serves a complete package",
    async () => {
      const { labels, killed, complete, detail } = await killAtEveryBoundary("swap");

      expect(killed.filter((run) => run.installed === null).map((run) => run.label)).toEqual([]);
      // One exchange publishes: the old package serves until its tool has ended.
      // The fixture cuts before it starts the tool, so no tool outlives a killed run.
      expect(labels.filter((label) => /^(start|end) /u.test(label))).toHaveLength(2);
      const started = labels.findIndex((label) => label.startsWith("start "));
      const ended = labels.findIndex((label) => label.startsWith("end "));
      expect(killed.map((run) => run.installed)).toEqual(
        labels.map((_, index) => (index < ended ? "2026.11.3" : "2026.12.1")),
      );
      expect(detail).toContain(`by an atomic exchange (${expectedPathExchangeRoute})`);
      // Local dist files are preserved from the old package while it still serves.
      const preserved = labels.findLastIndex((label) => label.includes("update-recovery"));
      expect(preserved).toBeGreaterThan(-1);
      expect(preserved).toBeLessThan(started);
      const recovery = path.join(complete.root, "state", "update-recovery");
      const [bundle] = fs.readdirSync(recovery);
      expect(
        fs.readFileSync(path.join(recovery, bundle!, "files", "dist", "build-info.json"), "utf8"),
      ).toContain("build-old");
      // The old package is retained under the backup name for the update run's rollback.
      expect(backups(complete.globalRoot).map(version)).toEqual(["2026.11.3"]);
    },
  );

  it.runIf(expectedPathExchangeRoute)(
    "before the exchange: the old package serves and the next verified swap removes the leftover",
    async () => {
      const complete = await runSwitch("complete", "swap", { root: path.join(dir, "complete") });
      const staged = complete.events.find((event) =>
        event.label?.endsWith("-> lib/node_modules/.openclaw.package-backup"),
      );
      // Killed with the new package under the backup name and the exchange not yet made.
      const state = await runSwitch(`boundary:${staged?.boundary}`, "swap");
      expect(version(state.slot)).toBe("2026.11.3");
      expect(backups(state.globalRoot).map(version)).toEqual(["2026.12.1"]);

      const next = await stagePackageRelease(
        { prefix: state.prefix, globalRoot: state.globalRoot, slot: state.slot },
        "2026.12.2",
        undefined,
        path.join(state.globalRoot, ".openclaw.update-stage-next"),
      );
      let transaction: PackageUpdateTransaction | undefined;
      const result = await swapStagedPackageInstall({
        ...next,
        onTransaction: (issued) => {
          transaction = issued;
        },
      });
      if (result.status !== "committed" || !transaction) {
        throw new Error(`expected a committed swap with a transaction: ${result.status}`);
      }
      // Verified completion retires this update's backup and the historical one.
      expect(await transaction.complete({ activationVerified: true }, () => {})).toBeUndefined();
      expect(version(state.slot)).toBe("2026.12.2");
      expect(backups(state.globalRoot)).toEqual([]);
    },
  );

  it("without an exchange tool: only the instant between the two renames has no package", async () => {
    const { killed, detail } = await killAtEveryBoundary("swap", "missing");
    expect(detail).toMatch(/two moves \(atomic exchange unavailable: .*ENOENT/u);

    // The same sweep finds the window that publishing after the backup rename leaves.
    const broken = killed.filter((run) => run.installed === null);
    expect(broken.map((run) => run.label)).toEqual([
      "rename lib/node_modules/openclaw -> lib/node_modules/.openclaw.package-backup",
    ]);
    const state = broken[0]!.state;
    expect(fs.lstatSync(state.slot, { throwIfNoEntry: false })).toBeUndefined();
    // The documented recovery: rename the backup onto the package path.
    fs.renameSync(backups(state.globalRoot)[0]!, state.slot);
    expect(version(state.slot)).toBe("2026.11.3");
    expect(launcherTarget(state.prefix)).toBe(path.join(state.slot, "openclaw.mjs"));
  });

  it.each(expectedPathExchangeRoute ? [undefined, "missing" as const] : ["missing" as const])(
    "after a failed verification: rollback restores the previous package (exchange tools: %s)",
    async (tools) => {
      const state = await runSwitch("complete", "swap", { tools, verification: "fails" });

      const outcome = state.events.at(-1);
      expect(outcome?.detail).toContain(tools ? "by two moves" : "by an atomic exchange");
      expect(outcome?.rollback).toEqual({ exitCode: 0, error: null });
      expect(version(state.slot)).toBe("2026.11.3");
      expect(fs.readFileSync(path.join(state.slot, "dist", "build-info.json"), "utf8")).toContain(
        "build-old",
      );
      expect(launcherTarget(state.prefix)).toBe(path.join(state.slot, "openclaw.mjs"));
      // Neither the backup nor the rejected candidate is left beside the package.
      expect(fs.readdirSync(state.globalRoot).toSorted()).toEqual([
        ".openclaw.update-stage-fixture",
        "openclaw",
      ]);
    },
  );
});

describe.skipIf(process.platform === "win32")("journaled publication killed by SIGKILL", () => {
  const fixtures = createPackageActivationLifetimeFixture();
  let journal: { root: string; env: ChildEnv };
  beforeEach(() => {
    const { root, childGuardEnv } = fixtures.setup();
    journal = { root, env: childGuardEnv };
  });
  afterEach(() => fixtures.cleanup());
  const anchored = (name: string) => `lib/node_modules/.openclaw.package-activation/${name}`;
  const read = (slot: string) =>
    openPackageActivationJournal(resolvePackageActivationAnchor(slot), { readOnly: true }).read();

  /**
   * Recover a killed run with the recovery the printed command runs: repair,
   * repair again, retire. Returns the phase repair reached, or undefined for a
   * run that died before it published a journal.
   */
  async function recover(slot: string) {
    const anchor = resolvePackageActivationAnchor(slot);
    if (!fs.existsSync(resolvePackageActivationJournalPath(anchor))) {
      expect(() => assertNoPendingPackageActivation(slot)).not.toThrow();
      return undefined;
    }
    const operation = read(slot).descriptor.operationId;
    const repair = () => runPackageActivationRecovery(anchor, "repair", operation);
    const layout = () => ({
      // The revision counts journal writes; a repeated completion rewrites the same record.
      record: { ...read(slot), revision: 0 },
      beside: fs.readdirSync(path.dirname(slot)).toSorted(),
      anchor: fs.readdirSync(anchor).toSorted(),
      serves: version(slot),
    });
    const repaired = await repair();
    const settled = layout();
    // A second repair changes nothing: an aborted publication refuses to be reopened.
    if (repaired.phase === "aborted") {
      await expect(repair()).rejects.toThrow("Forward publication is disarmed (aborted).");
    } else {
      expect(await repair()).toEqual(repaired);
    }
    expect(layout()).toEqual(settled);
    expect(await runPackageActivationRecovery(anchor, "retire", operation)).toMatchObject({
      phase: "complete",
    });
    expect(fs.existsSync(anchor)).toBe(false);
    expect(() => assertNoPendingPackageActivation(slot)).not.toThrow();
    return repaired.phase;
  }

  it.runIf(expectedPathExchangeRoute)(
    "at every boundary: the package path serves a complete package and recovery settles it",
    // About forty updaters run one at a time: they share one lease database.
    { timeout: 300_000 },
    () =>
      fixtures.lifetime.run(async () => {
        const { labels, killed, detail } = await killAtEveryBoundary("journal", undefined, journal);

        expect(killed.filter((run) => run.installed === null).map((run) => run.label)).toEqual([]);
        // One exchange publishes: the previous package serves until its tool has ended.
        expect(labels.filter((label) => /^(start|end) /u.test(label))).toHaveLength(2);
        const ended = labels.findIndex((label) => label.startsWith("end "));
        const serves = labels.map((_, index) => (index < ended ? "2026.11.3" : "2026.12.1"));
        expect(killed.map((run) => run.installed)).toEqual(serves);
        expect(detail).toContain(`published by an atomic exchange (${expectedPathExchangeRoute})`);
        // The candidate takes the previous name under a recorded publish intent, and
        // local dist files are preserved before that, while the old package serves.
        const waiting = labels.indexOf(
          `rename ${anchored("candidate")} -> ${anchored("previous")}`,
        );
        expect(waiting).toBe(ended - 2);
        expect(read(killed[waiting]!.state.slot)).toMatchObject({
          phase: "publishing",
          intent: { kind: "publish" },
          publications: [],
        });
        const preserved = labels.findLastIndex((label) => label.includes("update-recovery"));
        expect(preserved).toBeGreaterThan(-1);
        expect(preserved).toBeLessThan(waiting - 1);

        // A run killed before the exchange aborts to the previous package, with the
        // waiting candidate back under its own name; a later one completes the candidate.
        const published = labels.findIndex((label) => label.startsWith("renameSync "));
        const outcomes: Array<string | undefined> = [];
        for (const run of killed) {
          outcomes.push(await recover(run.state.slot));
        }
        expect(outcomes).toEqual(
          labels.map((_, index) =>
            index < published ? undefined : index < ended ? "aborted" : "publication-complete",
          ),
        );
        expect(killed.map((run) => version(run.state.slot))).toEqual(serves);
      }),
  );

  it(
    "without an exchange tool: only the instant between the two moves has no package",
    {
      timeout: 300_000,
    },
    () =>
      fixtures.lifetime.run(async () => {
        const { killed, detail } = await killAtEveryBoundary("journal", "missing", journal);
        expect(detail).toMatch(/two moves \(atomic exchange unavailable: .*ENOENT/u);

        // The same sweep finds the window that displacing before publishing leaves:
        // the displacement and the journal commit that records the publish intent.
        const broken = killed.filter((run) => run.installed === null);
        expect(broken.map((run) => run.label)).toEqual([
          `rename lib/node_modules/openclaw -> ${anchored("previous")}`,
          "journal commit",
        ]);
        // Only the recovery command restores an installation there, by publishing forward.
        for (const run of broken) {
          expect(() => assertNoPendingPackageActivation(run.state.slot)).toThrow(/incomplete/u);
          expect(await recover(run.state.slot)).toBe("publication-complete");
          expect(version(run.state.slot)).toBe("2026.12.1");
        }
      }),
  );

  it.each(expectedPathExchangeRoute ? [undefined, "missing" as const] : ["missing" as const])(
    "after a failed verification: rollback restores the previous package (exchange tools: %s)",
    (tools) =>
      fixtures.lifetime.run(async () => {
        const state = await runSwitch("complete", "journal", {
          root: journal.root,
          tools,
          verification: "fails",
          env: journal.env,
        });

        const outcome = state.events.at(-1);
        expect(outcome?.detail).toContain(tools ? "by two moves" : "by an atomic exchange");
        expect(outcome?.rollback).toEqual({ exitCode: 0, error: null });
        expect(version(state.slot)).toBe("2026.11.3");
        expect(fs.realpathSync(path.join(state.prefix, "bin", "openclaw"))).toBe(
          path.join(state.slot, "openclaw.mjs"),
        );
        expect(read(state.slot).phase).toBe("rolled-back");
        // Retirement removes the rejected candidate and the journal's custody.
        const anchor = resolvePackageActivationAnchor(state.slot);
        const operation = read(state.slot).descriptor.operationId;
        expect(await runPackageActivationRecovery(anchor, "retire", operation)).toMatchObject({
          phase: "complete",
        });
        expect(fs.existsSync(anchor)).toBe(false);
        expect(version(state.slot)).toBe("2026.11.3");
      }),
  );
});
