import { randomUUID } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writePackageDistInventory } from "../../../scripts/lib/package-dist-inventory.js";
import * as directoryDurability from "../../infra/directory-durability.js";
import {
  openPackageActivationJournal,
  packageActivationIdentity,
  resolvePackageActivationHelper,
  resolvePackageActivationJournalPath,
} from "../../infra/package-update-activation-journal.js";
import { createPackageActivationLifetimeFixture } from "../../infra/package-update-activation-lifetime.test-support.js";
import { prepareRemountedPublication } from "../../infra/package-update-activation-remount.test-support.js";
import {
  assertNoPendingPackageActivation,
  readPackageActivationReceipt,
} from "../../infra/package-update-activation.js";
import { createPackageIntegrityReader } from "../../infra/package-update-integrity.js";
import {
  publicationActivation,
  withPublicationFence,
} from "../../infra/package-update-publication.test-support.js";
import { writePackageRoot } from "../../infra/package-update-steps.test-support.js";
import { createPackageSwapFixture } from "../../infra/package-update-swap.test-support.js";
import { createRetainedUpdateRecovery } from "../../infra/update-retained-recovery.test-support.js";
import { readUpdateRunDriver } from "../../infra/update-run-driver.js";
import {
  createUpdateRun,
  getUpdateRun,
  recordUpdateRunPhase,
} from "../../infra/update-run-ledger.js";
import { loadPluginCohortRecovery } from "../../infra/update-run-recovery-store.js";
import { loadUpdateRecovery } from "../../infra/update-run-recovery.js";
import { defaultRuntime } from "../../runtime.js";
import { writeConfigMachineState } from "../../state/config-machine-state-write.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { runRegisteredCli } from "../../test-utils/command-runner.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { writeFixtureJsonSync } from "../cli-fixtures.test-support.js";
import { registerUpdateCli } from "../update-cli.js";
import { withUpdateCommandExecutor } from "./update-command-executor.js";
import {
  createInterruptedPackagePublication,
  preparePackagePublication,
} from "./update-package-publication.test-support.js";
import { updateRepairCommand } from "./update-repair-command.js";

const mocks = vi.hoisted(() => ({ root: vi.fn(), finalize: vi.fn() }));
vi.mock("./shared.js", async (original) => ({
  ...(await original<typeof import("./shared.js")>()),
  resolveUpdateRoot: mocks.root,
}));
vi.mock("./update-command-finalize.js", () => ({ updateFinalizeCommand: mocks.finalize }));

const fixtures = createPackageActivationLifetimeFixture();
let state: OpenClawTestState;
let fixtureRoot: string;
beforeEach(async () => {
  vi.clearAllMocks();
  fixtureRoot = fixtures.setup().root;
  state = await createOpenClawTestState({
    label: "repair-package-activation",
    env: { OPENCLAW_UPDATE_RUN_ID: undefined },
  });
  await state.writeConfig({ plugins: { enabled: false } });
  vi.spyOn(defaultRuntime, "error").mockImplementation(() => undefined);
  vi.spyOn(defaultRuntime, "exit").mockImplementation(() => undefined as never);
  mocks.finalize.mockImplementation(async () => {
    assertNoPendingPackageActivation(await mocks.root());
  });
});
afterEach(async () => {
  await state.cleanup();
  await fixtures.lifetime.cleanup();
  vi.restoreAllMocks();
});

async function preparedOwnershipMismatch() {
  const f = await fixtures.prepare((anchor) => {
    const launcher = path.resolve(path.dirname(anchor), "../../bin/openclaw");
    fs.unlinkSync(launcher);
    fs.symlinkSync("../lib/node_modules/openclaw/openclaw.mjs", launcher);
  });
  const record = openPackageActivationJournal(f.anchor).read();
  const observed = fs.lstatSync(f.launcher);
  // 2026.9.7 recorded the backup's gid when lchown could not preserve the live
  // link's group. Manual replacement must not require replaying that old intent.
  record.descriptor.launchers[0]!.previous = JSON.stringify([
    "symlink",
    observed.mode.toString(),
    observed.uid.toString(),
    (observed.gid + 1).toString(),
    fs.readlinkSync(f.launcher),
  ]);
  const journal = resolvePackageActivationJournalPath(f.anchor);
  const db = new DatabaseSync(journal);
  try {
    db.prepare("UPDATE package_activation SET descriptor_json = ?").run(
      JSON.stringify(record.descriptor),
    );
  } finally {
    db.close();
  }
  mocks.root.mockResolvedValue(f.packageRoot);
  const helper = resolvePackageActivationHelper(f.anchor);
  return {
    ...f,
    journal,
    helper,
    retained: `${f.anchor}.superseded-${f.operationId}`,
    helperBytes: fs.readFileSync(helper),
    descriptor: record.descriptor,
  };
}

async function manualInstall(f: Awaited<ReturnType<typeof preparedOwnershipMismatch>>) {
  fs.renameSync(f.packageRoot, `${f.packageRoot}.replaced-by-npm`);
  await writePackageRoot(f.packageRoot, "3.0.0");
  return packageActivationIdentity(f.packageRoot, true);
}

const supersessionReasons = [
  "superseded-by-manual-install",
  "recovery-lease-identity-changed",
  "recovery-lease-missing",
] as const;

async function obsoleteRecovery(
  f: Awaited<ReturnType<typeof preparedOwnershipMismatch>>,
  reason: (typeof supersessionReasons)[number],
) {
  if (reason === "superseded-by-manual-install") {
    return manualInstall(f);
  }
  const databasePath = f.descriptor.authority.databasePath;
  if (reason === "recovery-lease-missing") {
    fs.unlinkSync(databasePath);
  } else {
    fs.renameSync(databasePath, `${databasePath}.previous`);
    fs.copyFileSync(`${databasePath}.previous`, databasePath);
    fs.chmodSync(databasePath, 0o600);
  }
  return packageActivationIdentity(f.packageRoot, true);
}

function readArchivedSettlement(anchor: string, operationId: string) {
  const db = new DatabaseSync(
    path.join(`${anchor}.superseded-${operationId}`, "control/operation.sqlite"),
    { readOnly: true },
  );
  try {
    const row = db
      .prepare("SELECT phase, intent_json, descriptor_json FROM package_activation WHERE slot = 1")
      .get()!;
    return {
      phase: row.phase,
      intent: JSON.parse(String(row.intent_json)),
      descriptor: JSON.parse(String(row.descriptor_json)),
    };
  } finally {
    db.close();
  }
}

async function repair() {
  await updateRepairCommand({ json: true, yes: true });
}

it("settles the named plugin pair under native custody before repair finalization", async () => {
  await writePackageRoot(fixtureRoot, "2026.10.9");
  mocks.root.mockResolvedValue(fixtureRoot);
  const driver = readUpdateRunDriver();
  expect(driver).toBeDefined();
  const run = createUpdateRun({
    trigger: "cli",
    // A schema-valid different start identity represents an exited instance of this PID.
    origin: { driver: { ...driver!, startIdentity: String(BigInt(driver!.startIdentity) + 1n) } },
  });
  recordUpdateRunPhase(run.runId, "verifying");
  const runtime = {
    root: fixtureRoot,
    nodePath: process.execPath,
    version: "2026.10.9",
    buildId: null,
  };
  // A synthetic empty cohort isolates public repair admission and native settlement.
  const reservation = createRetainedUpdateRecovery({
    runId: run.runId,
    from: runtime,
    to: runtime,
  });
  writeConfigMachineState("update.pluginCohort." + run.runId, {
    runId: run.runId,
    transactionId: reservation.transactionId,
    revision: 0,
    disposition: "pending",
    installKey: fixtureRoot,
    priorArtifacts: [],
    artifacts: [],
    publications: [],
    settledPublications: 0,
  });
  mocks.finalize.mockImplementation(async () => {
    expect(loadPluginCohortRecovery(run.runId)).toBeUndefined();
    expect(loadUpdateRecovery(run.runId)).toBeUndefined();
    assertNoPendingPackageActivation(fixtureRoot);
  });
  await runRegisteredCli({
    register: registerUpdateCli,
    argv: ["update", "repair", "--json", "--yes"],
  });
  expect(mocks.finalize).toHaveBeenCalledOnce();
  expect(loadPluginCohortRecovery(run.runId)).toBeUndefined();
  expect(loadUpdateRecovery(run.runId)).toBeUndefined();
});

async function prepareNextPackage(
  f: Awaited<ReturnType<typeof createPackageSwapFixture>>,
  version = "3.0.0",
) {
  await writePackageRoot(f.params.stage.packageRoot, version);
  await fsp.mkdir(f.params.stage.layout.binDir, { recursive: true });
  await fsp.writeFile(path.join(f.params.stage.layout.binDir, "openclaw"), "new launcher\n");
  await withPublicationFence(f.packageRoot, (fence) =>
    preparePackagePublication(f, publicationActivation(fence)),
  );
}

async function interruptedPublication(
  phase: "prepared" | "publishing" | "publication-complete" = "publishing",
) {
  const fixture = await createInterruptedPackagePublication(fixtureRoot, phase);
  mocks.root.mockResolvedValue(fixture.packageRoot);
  return fixture;
}

describe.skipIf(process.platform === "win32")("public package repair of obsolete recovery", () => {
  it.each(["abandoned", "live ownership", "live sibling"] as const)(
    "repairs historical hostnames independently before remounted journal recovery: %s",
    async (scenario) => {
      const f = await prepareRemountedPublication(fixtures, fixtureRoot);
      mocks.root.mockResolvedValue(f.packageRoot);
      const driver = readUpdateRunDriver();
      expect(driver).toBeDefined();
      const runs = ["previous-mac.invalid", "renamed-mac.invalid"].map((host) => {
        const run = createUpdateRun({ trigger: "cli", origin: { driver: { ...driver!, host } } });
        recordUpdateRunPhase(run.runId, "verifying");
        return run.runId;
      });
      const ageMs = 14 * 24 * 60 * 60_000;
      openOpenClawStateDatabase()
        .db.prepare("UPDATE update_runs SET created_at_ms = ?, updated_at_ms = ?")
        .run(Date.now() - ageMs, Date.now() - ageMs);
      const repairCli = () =>
        runRegisteredCli({
          register: registerUpdateCli,
          argv: ["update", "repair", "--json", "--yes"],
        });
      if (scenario === "live ownership") {
        const journal = fs.readFileSync(f.journalPath);
        await withUpdateCommandExecutor(randomUUID(), async (executor) => {
          await executor.enter(f.packageRoot);
          await repairCli();
        });
        expect(defaultRuntime.exit).toHaveBeenCalledWith(1);
        expect(defaultRuntime.error).toHaveBeenCalledWith(
          expect.stringMatching(/wait.*owning host.*repair/iu),
        );
        expect(runs.map((id) => getUpdateRun(id)?.status)).toEqual(["running", "running"]);
        expect(fs.readFileSync(f.journalPath)).toEqual(journal);
        expect(mocks.finalize).not.toHaveBeenCalled();
        return;
      }
      const sibling =
        scenario === "live sibling"
          ? createUpdateRun({ trigger: "cli", origin: { driver } })
          : undefined;
      await repairCli();
      expect(runs.map((id) => getUpdateRun(id))).toEqual(
        runs.map((runId) =>
          expect.objectContaining({
            runId,
            status: "failed",
            phase: "finished",
            reason: "abandoned",
            finishedAtMs: expect.any(Number),
          }),
        ),
      );
      for (const [index, id] of runs.entries()) {
        expect(defaultRuntime.error).toHaveBeenCalledWith(expect.stringContaining(id));
        expect(defaultRuntime.error).toHaveBeenCalledWith(
          expect.stringContaining(index ? "renamed-mac.invalid" : "previous-mac.invalid"),
        );
      }
      if (sibling) {
        expect(getUpdateRun(sibling.runId)?.status).toBe("running");
        expect(defaultRuntime.exit).toHaveBeenCalledWith(1);
        expect(fs.existsSync(f.anchor)).toBe(true);
        expect(mocks.finalize).not.toHaveBeenCalled();
        return;
      }
      expect(defaultRuntime.exit).not.toHaveBeenCalled();
      expect(() => assertNoPendingPackageActivation(f.packageRoot)).not.toThrow();
      expect(fs.existsSync(f.anchor)).toBe(false);
      expect(mocks.finalize).toHaveBeenCalledOnce();
    },
  );

  it.each([
    "lost acknowledgement",
    "manual replacement",
    "published candidate",
    "replaced published launcher",
  ] as const)(
    "repairs remounted custody without accepting a foreign launcher: %s",
    async (scenario) => {
      const published =
        scenario === "published candidate" || scenario === "replaced published launcher";
      const f = await prepareRemountedPublication(
        fixtures,
        fixtureRoot,
        false,
        "equal-symlinks",
        "candidate",
        published,
      );
      mocks.root.mockResolvedValue(f.packageRoot);
      if (scenario === "manual replacement") {
        const db = new DatabaseSync(f.journalPath);
        try {
          db.prepare(
            "UPDATE package_activation SET phase = 'publication-complete', intent_json = 'null'",
          ).run();
        } finally {
          db.close();
        }
        fs.renameSync(f.packageRoot, `${f.packageRoot}.manual-backup`);
        fs.mkdirSync(f.packageRoot);
        writeFixtureJsonSync(path.join(f.packageRoot, "package.json"), {
          name: "openclaw",
          version: "2026.10.1",
          type: "module",
          bin: { openclaw: "./openclaw.mjs" },
        });
        fs.writeFileSync(path.join(f.packageRoot, "openclaw.mjs"), "// newer installed launcher\n");
        fs.mkdirSync(path.join(f.packageRoot, "dist"));
        fs.writeFileSync(
          path.join(f.packageRoot, "dist/build-info.json"),
          '{"version":"2026.10.1"}',
        );
        await writePackageDistInventory(f.packageRoot);
      }
      if (published) {
        // The writer must publish a new inode; the fixture only remaps device numbers afterward.
        expect(fs.lstatSync(f.launcher).ino.toString()).not.toBe(
          f.historical.launchers[0]!.candidateIdentity.split(":")[1],
        );
      }
      if (scenario === "replaced published launcher") {
        const target = fs.readlinkSync(f.launcher);
        fs.renameSync(f.launcher, `${f.launcher}.recorded`);
        fs.symlinkSync(target, f.launcher);
        const before = fs.readFileSync(f.journalPath);
        await expect(repair()).rejects.toThrow(
          "Package settlement inode or device mapping changed",
        );
        expect(fs.readFileSync(f.journalPath)).toEqual(before);
        expect(fs.existsSync(`${f.anchor}.superseded-${f.operationId}`)).toBe(false);
        expect(mocks.finalize).not.toHaveBeenCalled();
        return;
      }
      const installed = await createPackageIntegrityReader().tree(f.packageRoot);
      const previous = await createPackageIntegrityReader().tree(path.join(f.anchor, "previous"));
      await repair();
      expect(mocks.finalize).toHaveBeenCalledOnce();
      expect(() => assertNoPendingPackageActivation(f.packageRoot)).not.toThrow();
      expect(await createPackageIntegrityReader().tree(f.packageRoot)).toEqual(installed);
      const archived = readArchivedSettlement(f.anchor, f.operationId);
      expect(archived).toMatchObject({
        phase: "superseded",
        intent: {
          kind:
            scenario === "manual replacement"
              ? "superseded-by-manual-install"
              : "publication-settled-external-change",
          settled: true,
        },
        descriptor: f.historical,
      });
      expect(
        await createPackageIntegrityReader().tree(
          path.join(`${f.anchor}.superseded-${f.operationId}`, "previous"),
        ),
      ).toEqual(previous);
    },
  );

  it.each(["live executor", "unknown intent"] as const)(
    "preserves completed control evidence when archival is refused: %s",
    async (failure) => {
      const f = await preparedOwnershipMismatch();
      await manualInstall(f);
      vi.mocked(defaultRuntime.error).mockImplementationOnce(() => {
        throw new Error("reporting interrupted");
      });
      await expect(repair()).rejects.toThrow("reporting interrupted");
      if (failure === "unknown intent") {
        const db = new DatabaseSync(f.journal);
        try {
          db.prepare("UPDATE package_activation SET intent_json = ?").run(
            JSON.stringify({ kind: "future-settlement", settled: true }),
          );
        } finally {
          db.close();
        }
        expect(() => assertNoPendingPackageActivation(f.packageRoot)).toThrow();
      }
      const bytes = fs.readFileSync(f.journal);
      const identity = packageActivationIdentity(f.journal, false);
      if (failure === "live executor") {
        await withUpdateCommandExecutor(randomUUID(), async (executor) => {
          await executor.enter(f.packageRoot);
          await expect(repair()).rejects.toThrow(/executor.*owns|update.*owns/iu);
        });
      } else {
        await expect(repair()).rejects.toThrow();
      }
      expect(fs.readFileSync(f.journal)).toEqual(bytes);
      expect(packageActivationIdentity(f.journal, false)).toBe(identity);
      expect(fs.readFileSync(f.helper)).toEqual(f.helperBytes);
      expect(mocks.finalize).not.toHaveBeenCalled();
    },
  );

  it("settles the npm layout with dependency manifests and an external dist backup", async () => {
    const f = await interruptedPublication();
    fs.symlinkSync("missing-extra-target", path.join(f.packageRoot, "dist/extra-link"));
    const helper = fs.readFileSync(resolvePackageActivationHelper(f.anchor));
    await repair();
    expect(readPackageActivationReceipt(f.packageRoot)).toBeUndefined();
    expect(() => assertNoPendingPackageActivation(f.packageRoot)).not.toThrow();
    expect(readArchivedSettlement(f.anchor, f.record.descriptor.operationId)).toMatchObject({
      phase: "superseded",
      intent: { kind: "publication-settled-external-change", settled: true },
      descriptor: f.record.descriptor,
    });
    const retained = `${f.anchor}.superseded-${f.record.descriptor.operationId}`;
    expect(fs.readFileSync(path.join(retained, "control/recovery.mjs"))).toEqual(helper);
    expect(fs.readFileSync(path.join(retained, "previous/package.json"), "utf8")).toContain(
      "1.0.0",
    );
    expect(fs.readFileSync(path.join(f.packageRoot, "package.json"), "utf8")).toContain("2.0.0");
    expect(fs.readFileSync(path.join(f.packageRoot, "dist/index.js"), "utf8")).toBe("export {};\n");
    expect(fs.readlinkSync(f.launcher)).toBe("../lib/node_modules/openclaw/openclaw.mjs");
    expect(fs.readFileSync(f.launcher, "utf8")).toBe('import "./dist/index.js";\n');
    for (const detail of [
      "publication-settled-external-change",
      "dist/index.js.bak",
      "dist/extra-link",
      "Root package.json was field-verified, not content-verified.",
      "Entry targets outside dist were checked for resolution, not content.",
    ]) {
      expect(defaultRuntime.error).toHaveBeenCalledWith(expect.stringContaining(detail));
    }
    expect(getUpdateRun(f.record.descriptor.operationId)).toMatchObject({
      status: "succeeded",
      reason: "publication-settled-external-change",
      steps: expect.arrayContaining([
        expect.objectContaining({
          step: "reconcile:settle",
          detail: expect.stringContaining("dist/index.js.bak"),
        }),
        expect.objectContaining({
          detail: expect.stringContaining(
            "Root package.json was field-verified, not content-verified.",
          ),
        }),
      ]),
    });
    await prepareNextPackage(f);
    expect(openPackageActivationJournal(f.anchor).read().phase).toBe("prepared");
    expect(openPackageActivationJournal(f.anchor).read().descriptor.operationId).not.toBe(
      f.record.descriptor.operationId,
    );
    expect(fs.readFileSync(path.join(retained, "control/recovery.mjs"))).toEqual(helper);
  });

  it.each(supersessionReasons)(
    "settles rollback only after its installation is replaced: %s",
    async (reason) => {
      const f = await preparedOwnershipMismatch();
      await withUpdateCommandExecutor(randomUUID(), async (executor) => {
        const fence = await executor.enter(f.packageRoot);
        const journal = openPackageActivationJournal(f.anchor);
        journal.transition(journal.read(), "rollback-in-progress", null, fence.assertCurrent);
      });
      await obsoleteRecovery(f, reason);
      if (reason === "superseded-by-manual-install") {
        const installed = await createPackageIntegrityReader().tree(f.packageRoot);
        await repair();
        expect(readArchivedSettlement(f.anchor, f.operationId).intent).toMatchObject({
          kind: reason,
          settled: true,
        });
        expect(await createPackageIntegrityReader().tree(f.packageRoot)).toEqual(installed);
        expect(() => assertNoPendingPackageActivation(f.packageRoot)).not.toThrow();
        expect(mocks.finalize).toHaveBeenCalledOnce();
        return;
      }
      const journal = fs.readFileSync(f.journal);
      await expect(repair()).rejects.toThrow(/restoration|rollback/iu);
      expect(fs.readFileSync(f.journal)).toEqual(journal);
      expect(fs.existsSync(f.retained)).toBe(false);
      expect(mocks.finalize).not.toHaveBeenCalled();
    },
  );

  it.each([
    { field: "exports", value: { ".": { import: "./dist/index.js", default: "./missing.js" } } },
  ])(
    "keeps recovery armed for an unverified root package.json $field",
    async ({ field, value }) => {
      const f = await interruptedPublication();
      const manifestPath = path.join(f.packageRoot, "package.json");
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      writeFixtureJsonSync(manifestPath, { ...manifest, [field]: value });
      const journal = fs.readFileSync(resolvePackageActivationJournalPath(f.anchor));
      await expect(repair()).rejects.toThrow("package.json");
      expect(fs.readFileSync(resolvePackageActivationJournalPath(f.anchor))).toEqual(journal);
      expect(f.journal.read().phase).toBe("publishing");
      expect(mocks.finalize).not.toHaveBeenCalled();
    },
  );

  it.each([{ boundary: "control", lease: "replaced" }] as const)(
    "keeps updates admitted after failed $boundary archival with lease $lease",
    async () => {
      const f = await interruptedPublication();
      const rename = fs.renameSync.bind(fs);
      const interruption = vi.spyOn(fs, "renameSync").mockImplementation((source, destination) => {
        if (source === `${f.anchor}.control`) {
          throw new Error("evidence archive unavailable");
        }
        rename(source, destination);
      });
      await repair();
      interruption.mockRestore();
      expect(f.journal.read().intent).toMatchObject({
        kind: "publication-settled-external-change",
        settled: true,
      });
      expect(() => assertNoPendingPackageActivation(f.packageRoot)).not.toThrow();
      expect(defaultRuntime.error).toHaveBeenCalledWith(
        expect.stringContaining("evidence archive unavailable"),
      );
      const databasePath = f.record.descriptor.authority.databasePath;
      fs.renameSync(databasePath, `${databasePath}.previous`);
      fs.copyFileSync(`${databasePath}.previous`, databasePath);
      fs.chmodSync(databasePath, 0o600);
      await repair();
      expect(
        readArchivedSettlement(f.anchor, f.record.descriptor.operationId).intent,
      ).toMatchObject({
        kind: "publication-settled-external-change",
        settled: true,
      });
      expect(readPackageActivationReceipt(f.packageRoot)).toBeUndefined();
      await prepareNextPackage(f);
      expect(openPackageActivationJournal(f.anchor).read().phase).toBe("prepared");
    },
  );

  it.each(
    (["publishing"] as const).flatMap((phase) =>
      (
        [
          "content mismatch",
          "inventoried symlink",
          "unsupported launcher synchronization",
          "live executor",
          "wrong version",
        ] as const
      ).map((failure) => ({ phase, failure })),
    ),
  )("preserves a $phase operation with $failure", async ({ phase, failure }) => {
    const f = await interruptedPublication(phase);
    if (failure === "content mismatch") {
      fs.writeFileSync(path.join(f.packageRoot, "dist/index.js"), "// still patched\n");
    }
    if (failure === "inventoried symlink") {
      fs.unlinkSync(path.join(f.packageRoot, "dist/index.js"));
      fs.symlinkSync("index.js.bak", path.join(f.packageRoot, "dist/index.js"));
    }
    if (failure === "unsupported launcher synchronization") {
      const sync = directoryDurability.syncDirectory;
      vi.spyOn(directoryDurability, "syncDirectory").mockImplementation(async (...args) =>
        args[0] === f.record.descriptor.binDir
          ? { status: "unsupported", code: "EINVAL" }
          : sync(...args),
      );
    }
    if (failure === "wrong version") {
      writeFixtureJsonSync(path.join(f.packageRoot, "dist/build-info.json"), { version: "1.0.0" });
      await writePackageDistInventory(f.packageRoot);
    }
    const journal = fs.readFileSync(resolvePackageActivationJournalPath(f.anchor));
    if (failure === "live executor") {
      await withUpdateCommandExecutor(randomUUID(), async (executor) => {
        await executor.enter(f.packageRoot);
        await expect(repair()).rejects.toThrow(/executor.*owns|update.*owns/iu);
      });
    } else {
      await expect(repair()).rejects.toThrow(
        failure === "content mismatch"
          ? /dist\/index.js/u
          : failure === "inventoried symlink"
            ? /symlink path component not allowed/u
            : failure === "unsupported launcher synchronization"
              ? /crash-durable directory synchronization/u
              : /version/iu,
      );
    }
    expect(fs.readFileSync(resolvePackageActivationJournalPath(f.anchor))).toEqual(journal);
    expect(fs.existsSync(f.anchor)).toBe(true);
    expect(mocks.finalize).not.toHaveBeenCalled();
  });

  it.each(["legacy launcher group"] as const)(
    "retires an untouched prepared publication and admits the next update: %s",
    async () => {
      const f = await preparedOwnershipMismatch();
      mocks.root.mockResolvedValue(f.packageRoot);
      const prepared = openPackageActivationJournal(f.anchor).read();
      expect(prepared).toMatchObject({ phase: "prepared", intent: null, publications: [] });
      const launcher = fs.lstatSync(f.launcher);
      const readLauncher = () =>
        launcher.isSymbolicLink() ? fs.readlinkSync(f.launcher) : fs.readFileSync(f.launcher);
      const launcherContents = readLauncher();
      const packageBytes = fs.readFileSync(path.join(f.packageRoot, "package.json"));

      await repair();

      expect(readPackageActivationReceipt(f.packageRoot)).toMatchObject({ phase: "complete" });
      expect(() => assertNoPendingPackageActivation(f.packageRoot)).not.toThrow();
      expect(fs.existsSync(f.anchor)).toBe(false);
      expect(fs.existsSync(resolvePackageActivationHelper(f.anchor))).toBe(false);
      expect(packageActivationIdentity(f.packageRoot, true)).toBe(
        prepared.descriptor.previous.identity,
      );
      expect(fs.readFileSync(path.join(f.packageRoot, "package.json"))).toEqual(packageBytes);
      expect(fs.lstatSync(f.launcher).ino).toBe(launcher.ino);
      expect(readLauncher()).toEqual(launcherContents);
      expect(defaultRuntime.error).toHaveBeenCalledWith(
        expect.stringContaining("publication-not-started"),
      );
      expect(mocks.finalize).toHaveBeenCalledOnce();
    },
  );

  it.each([
    { reason: "superseded-by-manual-install", drift: "helper changed" },
    { reason: "recovery-lease-identity-changed", drift: "helper missing" },
    { reason: "recovery-lease-missing", drift: "anchor replaced" },
    { reason: "recovery-lease-missing", drift: "archive collision" },
  ] as const)(
    "closes obsolete $reason despite $drift without deleting evidence",
    async ({ reason, drift }) => {
      const f = await preparedOwnershipMismatch();
      const replacementIdentity = await obsoleteRecovery(f, reason);
      if (drift === "helper changed") {
        fs.writeFileSync(f.helper, "changed obsolete helper");
      } else if (drift === "helper missing") {
        fs.unlinkSync(f.helper);
      } else if (drift === "anchor replaced") {
        fs.renameSync(f.anchor, `${f.anchor}.external-copy`);
        fs.mkdirSync(f.anchor, { mode: 0o700 });
        fs.writeFileSync(path.join(f.anchor, "evidence"), "preserve replacement");
      } else {
        fs.mkdirSync(f.retained, { mode: 0o700 });
        fs.writeFileSync(path.join(f.retained, "evidence"), "preserve collision");
      }
      await repair();
      expect(() => assertNoPendingPackageActivation(f.packageRoot)).not.toThrow();
      expect(packageActivationIdentity(f.packageRoot, true)).toBe(replacementIdentity);
      expect(mocks.finalize).toHaveBeenCalledOnce();
      if (drift === "helper changed") {
        expect(fs.readFileSync(path.join(f.retained, "control/recovery.mjs"), "utf8")).toBe(
          "changed obsolete helper",
        );
      } else if (drift === "anchor replaced" || drift === "archive collision") {
        expect(fs.readFileSync(path.join(f.retained, "evidence"), "utf8")).toBe(
          drift === "anchor replaced" ? "preserve replacement" : "preserve collision",
        );
      }
    },
  );

  it("does not treat a dangling lease database symlink as a missing database", async () => {
    const f = await preparedOwnershipMismatch();
    const databasePath = f.descriptor.authority.databasePath;
    fs.unlinkSync(databasePath);
    const target = `${databasePath}.absent`;
    fs.symlinkSync(target, databasePath);
    const journal = fs.readFileSync(f.journal);

    await expect(repair()).rejects.toThrow(/ENOENT/);

    expect(fs.readlinkSync(databasePath)).toBe(target);
    expect(fs.existsSync(target)).toBe(false);
    expect(fs.readFileSync(f.journal)).toEqual(journal);
    expect(fs.readFileSync(f.helper)).toEqual(f.helperBytes);
    expect(fs.existsSync(f.retained)).toBe(false);
    expect(mocks.finalize).not.toHaveBeenCalled();
  });

  it("retains the original replacement fact when the live installation changes during archival", async () => {
    const f = await preparedOwnershipMismatch();
    const replacementIdentity = await manualInstall(f);
    const rename = fs.renameSync.bind(fs);
    const replacement = vi.spyOn(fs, "renameSync").mockImplementation((source, destination) => {
      rename(source, destination);
      if (source === f.anchor) {
        fs.renameSync(f.packageRoot, `${f.packageRoot}.replaced-again`);
        fs.cpSync(`${f.packageRoot}.replaced-again`, f.packageRoot, { recursive: true });
        writeFixtureJsonSync(path.join(f.packageRoot, "package.json"), {
          name: "openclaw",
          version: "4.0.0",
        });
      }
    });

    await expect(repair()).rejects.toThrow(/changed/iu);
    replacement.mockRestore();

    expect(openPackageActivationJournal(f.anchor).read()).toMatchObject({
      phase: "superseded",
      intent: { kind: "superseded-by-manual-install", replacementIdentity, settled: true },
    });
    expect(packageActivationIdentity(f.packageRoot, true)).not.toBe(replacementIdentity);
    expect(fs.readFileSync(path.join(f.packageRoot, "package.json"), "utf8")).toContain("4.0.0");
    expect(() => assertNoPendingPackageActivation(f.packageRoot)).not.toThrow();
    expect(mocks.finalize).not.toHaveBeenCalled();

    await repair();

    expect(readArchivedSettlement(f.anchor, f.operationId)).toMatchObject({
      phase: "superseded",
      intent: { kind: "superseded-by-manual-install", replacementIdentity, settled: true },
    });
    expect(() => assertNoPendingPackageActivation(f.packageRoot)).not.toThrow();
  });
});
