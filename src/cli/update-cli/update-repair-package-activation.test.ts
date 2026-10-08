import { randomUUID } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writePackageDistInventory } from "../../../scripts/lib/package-dist-inventory.js";
import * as directoryDurability from "../../infra/directory-durability.js";
import {
  encodePackageActivationLauncher,
  openPackageActivationJournal,
  packageActivationIdentity,
  resolvePackageActivationHelper,
  resolvePackageActivationJournalPath,
} from "../../infra/package-update-activation-journal.js";
import { createPackageActivationLifetimeFixture } from "../../infra/package-update-activation-lifetime.test-support.js";
import { preparePackageActivationJournal } from "../../infra/package-update-activation-prepare.js";
import { packageActivationRuntimeForTest } from "../../infra/package-update-activation-runtime.test-support.js";
import {
  assertNoPendingPackageActivation,
  readPackageActivationReceipt,
  readPackageActivationStatus,
  runPackageActivationRecovery,
} from "../../infra/package-update-activation.js";
import { createPackageIntegrityReader } from "../../infra/package-update-integrity.js";
import { createPublicationOwner } from "../../infra/package-update-publication-owner.js";
import { writePackageRoot } from "../../infra/package-update-steps.test-support.js";
import { createPackageSwapFixture } from "../../infra/package-update-swap.test-support.js";
import { getUpdateRun } from "../../infra/update-run-ledger.js";
import { defaultRuntime } from "../../runtime.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { withUpdateCommandExecutor } from "./update-command-executor.js";
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

async function repair() {
  await updateRepairCommand({ json: true, yes: true });
}

async function prepareNextPackage(
  f: Awaited<ReturnType<typeof createPackageSwapFixture>>,
  version = "3.0.0",
) {
  await writePackageRoot(f.params.stage.packageRoot, version);
  await fsp.mkdir(f.params.stage.layout.binDir, { recursive: true });
  await fsp.writeFile(path.join(f.params.stage.layout.binDir, "openclaw"), "new launcher\n");
  await withUpdateCommandExecutor(randomUUID(), async (executor) => {
    const reader = createPackageIntegrityReader();
    await preparePackageActivationJournal({
      options: {
        fence: await executor.enter(f.packageRoot),
        runtime: packageActivationRuntimeForTest(),
        onPrepared: () => {},
      },
      liveRoot: f.packageRoot,
      stageRoot: f.params.stage.packageRoot,
      launcherRoot: f.params.stage.layout.binDir,
      binDir: path.dirname(f.launcher),
      previous: await reader.tree(f.packageRoot),
      launchers: [
        {
          name: "openclaw",
          previous: encodePackageActivationLauncher(await reader.launcher(f.launcher)),
        },
      ],
    });
  });
}

async function interruptedPublication(phase: "publishing" | "publication-complete" = "publishing") {
  const f = await createPackageSwapFixture(fixtureRoot);
  const stageRoot = f.params.stage.packageRoot;
  fs.writeFileSync(
    path.join(stageRoot, "package.json"),
    JSON.stringify({
      name: "openclaw",
      version: "2.0.0",
      type: "module",
      main: "dist/index.js",
      exports: {
        ".": { import: "./dist/index.js", default: ["./dist/index.js", null] },
        "./nested": "./dist/nested/index.js",
        "./cli-entry": "./openclaw.mjs",
        "./package.json": "./package.json",
      },
      bin: { openclaw: "openclaw.mjs" },
    }),
  );
  fs.writeFileSync(path.join(stageRoot, "openclaw.mjs"), 'import "./dist/index.js";\n');
  const stagedLauncher = path.join(f.params.stage.layout.binDir, "openclaw");
  fs.unlinkSync(stagedLauncher);
  fs.symlinkSync("../lib/node_modules/openclaw/openclaw.mjs", stagedLauncher);
  fs.writeFileSync(path.join(stageRoot, "README.md"), "Synthetic package README\n");
  fs.writeFileSync(path.join(stageRoot, "LICENSE"), "Synthetic package license\n");
  for (const dependency of ["dep-a", "@scope/dep-b", "dep-a/node_modules/dep-c"]) {
    const directory = path.join(stageRoot, "node_modules", dependency);
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(
      path.join(directory, "package.json"),
      JSON.stringify({ name: path.basename(dependency), version: "1.0.0", type: "commonjs" }),
    );
  }
  fs.mkdirSync(path.join(stageRoot, "dist/nested"));
  fs.writeFileSync(path.join(stageRoot, "dist/nested/index.js"), "export {};\n");
  fs.mkdirSync(path.join(stageRoot, "dist/scoped"));
  fs.writeFileSync(
    path.join(stageRoot, "dist/scoped/package.json"),
    JSON.stringify({ type: "module" }),
  );
  fs.writeFileSync(
    path.join(stageRoot, "dist/build-info.json"),
    JSON.stringify({ version: "2.0.0" }),
  );
  await writePackageDistInventory(stageRoot);
  const reader = createPackageIntegrityReader();
  const prepared = await withUpdateCommandExecutor(randomUUID(), async (executor) => {
    const fence = await executor.enter(f.packageRoot);
    const preparation = await preparePackageActivationJournal({
      options: { fence, runtime: packageActivationRuntimeForTest(), onPrepared: () => {} },
      liveRoot: f.packageRoot,
      stageRoot,
      launcherRoot: f.params.stage.layout.binDir,
      binDir: path.dirname(f.launcher),
      previous: await reader.tree(f.packageRoot),
      launchers: [
        {
          name: "openclaw",
          previous: encodePackageActivationLauncher(await reader.launcher(f.launcher)),
        },
      ],
    });
    const rename = fsp.rename.bind(fsp);
    const interruption = vi.spyOn(fsp, "rename").mockImplementation(async (source, destination) => {
      await rename(source, destination);
      if (destination === f.launcher && phase === "publishing") {
        const file = path.join(f.packageRoot, "dist/index.js");
        const original = fs.readFileSync(file);
        fs.writeFileSync(`${file}.bak`, original);
        fs.writeFileSync(file, "// external patch\n");
        fs.writeFileSync(file, original);
        throw new Error("external write during publication");
      }
    });
    try {
      const publication = createPublicationOwner(
        preparation.anchor,
        preparation.journal,
        fence.assertCurrent,
        preparation.initial,
      ).publish(false);
      if (phase === "publishing") {
        await expect(publication).rejects.toThrow("external write during publication");
      } else {
        await publication;
      }
    } finally {
      interruption.mockRestore();
    }
    return preparation;
  });
  mocks.root.mockResolvedValue(f.packageRoot);
  const record = prepared.journal.read();
  expect(record.phase).toBe(phase);
  if (phase === "publishing") {
    await expect(
      runPackageActivationRecovery(prepared.anchor, "repair", record.descriptor.operationId),
    ).rejects.toThrow("Package publication object changed");
    await expect(
      runPackageActivationRecovery(prepared.anchor, "retire", record.descriptor.operationId),
    ).rejects.toThrow("Package evidence cannot be retired (publishing)");
  }
  expect(
    await readPackageActivationStatus(prepared.anchor, record.descriptor.operationId),
  ).toMatchObject({ phase });
  return { ...f, ...prepared, record };
}

describe.skipIf(process.platform === "win32")("public package repair of obsolete recovery", () => {
  it("settles a completed publication while preserving changed previous-package evidence", async () => {
    const f = await interruptedPublication("publication-complete");
    const previousFile = path.join(f.anchor, "previous/dist/index.js");
    const link = path.join(fixtureRoot, "retained-runtime-link");
    fs.linkSync(previousFile, link);
    fs.unlinkSync(link);
    fs.appendFileSync(previousFile, "// preserved recovery evidence\n");
    const previousIdentity = packageActivationIdentity(path.join(f.anchor, "previous"), true);
    const previousBytes = fs.readFileSync(previousFile);
    const liveBytes = fs.readFileSync(path.join(f.packageRoot, "dist/index.js"));
    const helper = fs.readFileSync(resolvePackageActivationHelper(f.anchor));
    const launcherIdentity = packageActivationIdentity(f.launcher, "launcher");

    await repair();

    const retained = `${f.anchor}.superseded-${f.record.descriptor.operationId}`;
    expect(f.journal.read()).toMatchObject({
      phase: "superseded",
      intent: { kind: "publication-settled-external-change", settled: true },
      descriptor: f.record.descriptor,
    });
    expect(readPackageActivationReceipt(f.packageRoot)).toMatchObject({ phase: "complete" });
    expect(() => assertNoPendingPackageActivation(f.packageRoot)).not.toThrow();
    expect(packageActivationIdentity(path.join(retained, "previous"), true)).toBe(previousIdentity);
    expect(fs.readFileSync(path.join(retained, "previous/dist/index.js"))).toEqual(previousBytes);
    expect(fs.readFileSync(path.join(retained, "recovery.mjs"))).toEqual(helper);
    expect(fs.readFileSync(path.join(f.packageRoot, "dist/index.js"))).toEqual(liveBytes);
    expect(packageActivationIdentity(f.launcher, "launcher")).toBe(launcherIdentity);
    await prepareNextPackage(f);
    expect(f.journal.read().phase).toBe("prepared");
    expect(fs.readFileSync(path.join(retained, "previous/dist/index.js"))).toEqual(previousBytes);
  });

  it("settles the npm layout with dependency manifests and an external dist backup", async () => {
    const f = await interruptedPublication();
    fs.symlinkSync("missing-extra-target", path.join(f.packageRoot, "dist/extra-link"));
    const helper = fs.readFileSync(resolvePackageActivationHelper(f.anchor));
    await repair();
    expect(readPackageActivationReceipt(f.packageRoot)).toMatchObject({ phase: "complete" });
    expect(() => assertNoPendingPackageActivation(f.packageRoot)).not.toThrow();
    expect(f.journal.read()).toMatchObject({
      phase: "superseded",
      intent: { kind: "publication-settled-external-change", settled: true },
      descriptor: f.record.descriptor,
    });
    const retained = `${f.anchor}.superseded-${f.record.descriptor.operationId}`;
    expect(fs.readFileSync(path.join(retained, "recovery.mjs"))).toEqual(helper);
    expect(fs.readFileSync(path.join(retained, "previous/package.json"), "utf8")).toContain(
      "1.0.0",
    );
    expect(fs.readFileSync(path.join(f.packageRoot, "package.json"), "utf8")).toContain("2.0.0");
    expect(fs.readFileSync(path.join(f.packageRoot, "dist/index.js"), "utf8")).toBe("export {};\n");
    expect(fs.readlinkSync(f.launcher)).toBe("../lib/node_modules/openclaw/openclaw.mjs");
    expect(fs.readFileSync(f.launcher, "utf8")).toBe('import "./dist/index.js";\n');
    expect(defaultRuntime.error).toHaveBeenCalledWith(
      expect.stringContaining("publication-settled-external-change"),
    );
    expect(defaultRuntime.error).toHaveBeenCalledWith(expect.stringContaining("dist/index.js.bak"));
    expect(defaultRuntime.error).toHaveBeenCalledWith(expect.stringContaining("dist/extra-link"));
    expect(defaultRuntime.error).toHaveBeenCalledWith(
      expect.stringContaining("Root package.json was field-verified, not content-verified."),
    );
    expect(defaultRuntime.error).toHaveBeenCalledWith(
      expect.stringContaining(
        "Entry targets outside dist were checked for resolution, not content.",
      ),
    );
    expect(getUpdateRun(f.record.descriptor.operationId)).toMatchObject({
      status: "succeeded",
      reason: "publication-settled-external-change",
      steps: expect.arrayContaining([
        expect.objectContaining({
          step: "reconcile:settle",
          detail: expect.stringContaining("dist/index.js.bak"),
        }),
      ]),
    });
    expect(getUpdateRun(f.record.descriptor.operationId)?.steps).toContainEqual(
      expect.objectContaining({
        detail: expect.stringContaining(
          "Root package.json was field-verified, not content-verified.",
        ),
      }),
    );
    await prepareNextPackage(f);
    expect(f.journal.read().phase).toBe("prepared");
    expect(f.journal.read().descriptor.operationId).not.toBe(f.record.descriptor.operationId);
    expect(fs.readFileSync(path.join(retained, "recovery.mjs"))).toEqual(helper);
  });

  it("keeps lease-identity settlement when the published candidate's lease database was replaced", async () => {
    const f = await interruptedPublication();
    const databasePath = f.record.descriptor.authority.databasePath;
    fs.renameSync(databasePath, `${databasePath}.previous`);
    fs.copyFileSync(`${databasePath}.previous`, databasePath);
    fs.chmodSync(databasePath, 0o600);
    await repair();
    expect(f.journal.read().intent).toMatchObject({
      kind: "recovery-lease-identity-changed",
      settled: true,
    });
    expect(readPackageActivationReceipt(f.packageRoot)).toMatchObject({ phase: "complete" });
    await prepareNextPackage(f);
    expect(f.journal.read().phase).toBe("prepared");
  });

  it.each(["dist/package.json", "dist/nested/package.json"])(
    "keeps recovery armed when an extra %s can change module loading",
    async (relative) => {
      const f = await interruptedPublication();
      const file = path.join(f.packageRoot, relative);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ type: "commonjs" }));
      const journal = fs.readFileSync(resolvePackageActivationJournalPath(f.anchor));
      await expect(repair()).rejects.toThrow(relative);
      expect(fs.readFileSync(resolvePackageActivationJournalPath(f.anchor))).toEqual(journal);
      expect(f.journal.read().phase).toBe("publishing");
      expect(fs.existsSync(resolvePackageActivationHelper(f.anchor))).toBe(true);
      expect(mocks.finalize).not.toHaveBeenCalled();
    },
  );

  it.each([
    { field: "name", value: "other-package" },
    { field: "version", value: "1.0.0" },
    { field: "type", value: "commonjs" },
    { field: "main", value: "missing.js" },
    { field: "exports", value: { ".": { import: "./dist/index.js", default: "./missing.js" } } },
    { field: "bin", value: { openclaw: "dangling.mjs" } },
    { field: "parse", value: null },
  ])(
    "keeps recovery armed for an unverified root package.json $field",
    async ({ field, value }) => {
      const f = await interruptedPublication();
      const manifestPath = path.join(f.packageRoot, "package.json");
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      fs.symlinkSync("missing.mjs", path.join(f.packageRoot, "dangling.mjs"));
      fs.writeFileSync(
        manifestPath,
        field === "parse" ? "{" : JSON.stringify({ ...manifest, [field]: value }),
      );
      const journal = fs.readFileSync(resolvePackageActivationJournalPath(f.anchor));
      await expect(repair()).rejects.toThrow("package.json");
      expect(fs.readFileSync(resolvePackageActivationJournalPath(f.anchor))).toEqual(journal);
      expect(f.journal.read().phase).toBe("publishing");
      expect(mocks.finalize).not.toHaveBeenCalled();
    },
  );

  it.each([
    { boundary: "anchor", lease: "current" },
    { boundary: "helper", lease: "current" },
    { boundary: "anchor", lease: "missing" },
    { boundary: "helper", lease: "replaced" },
  ] as const)(
    "resumes verified settlement after $boundary rename with lease $lease",
    async ({ boundary, lease }) => {
      const f = await interruptedPublication();
      const rename = fsp.rename.bind(fsp);
      const interruption = vi
        .spyOn(fsp, "rename")
        .mockImplementation(async (source, destination) => {
          await rename(source, destination);
          if (
            source === (boundary === "anchor" ? f.anchor : resolvePackageActivationHelper(f.anchor))
          ) {
            throw new Error("settlement acknowledgement lost");
          }
        });
      await expect(repair()).rejects.toThrow("settlement acknowledgement lost");
      interruption.mockRestore();
      expect(f.journal.read().intent).toMatchObject({
        kind: "publication-settled-external-change",
        settled: false,
      });
      if (lease !== "current") {
        const databasePath = f.record.descriptor.authority.databasePath;
        fs.renameSync(databasePath, `${databasePath}.previous`);
        if (lease === "replaced") {
          fs.copyFileSync(`${databasePath}.previous`, databasePath);
          fs.chmodSync(databasePath, 0o600);
        }
      }
      await repair();
      expect(f.journal.read().intent).toMatchObject({
        kind:
          lease === "current"
            ? "publication-settled-external-change"
            : lease === "missing"
              ? "recovery-lease-missing"
              : "recovery-lease-identity-changed",
        settled: true,
      });
      expect(readPackageActivationReceipt(f.packageRoot)).toMatchObject({ phase: "complete" });
      if (lease === "current") {
        expect(getUpdateRun(f.record.descriptor.operationId)?.steps).toContainEqual(
          expect.objectContaining({ detail: expect.stringContaining("dist/index.js.bak") }),
        );
      }
      await prepareNextPackage(f);
      expect(f.journal.read().phase).toBe("prepared");
    },
  );

  it.each(["current", "missing", "replaced"] as const)(
    "replays completed custody after interrupted reporting with lease %s",
    async (lease) => {
      const f = await interruptedPublication();
      vi.mocked(defaultRuntime.error).mockImplementationOnce(() => {
        throw new Error("reporting interrupted");
      });
      await expect(repair()).rejects.toThrow("reporting interrupted");
      expect(readPackageActivationReceipt(f.packageRoot)).toMatchObject({ phase: "complete" });
      expect(getUpdateRun(f.record.descriptor.operationId)).toBeUndefined();
      if (lease !== "current") {
        const databasePath = f.record.descriptor.authority.databasePath;
        fs.renameSync(databasePath, `${databasePath}.previous`);
        if (lease === "replaced") {
          fs.copyFileSync(`${databasePath}.previous`, databasePath);
          fs.chmodSync(databasePath, 0o600);
        }
      }
      await repair();
      const receipt = getUpdateRun(f.record.descriptor.operationId);
      expect(receipt).toMatchObject({
        status: "succeeded",
        reason:
          lease === "current"
            ? "publication-settled-external-change"
            : lease === "missing"
              ? "recovery-lease-missing"
              : "recovery-lease-identity-changed",
      });
      await repair();
      expect(getUpdateRun(f.record.descriptor.operationId)).toEqual(receipt);
      expect(receipt?.steps).toContainEqual(
        expect.objectContaining({ detail: expect.stringContaining("dist/index.js.bak") }),
      );
      await prepareNextPackage(f);
      expect(f.journal.read().phase).toBe("prepared");
    },
  );

  it.each(
    (["publishing", "publication-complete"] as const).flatMap((phase) =>
      (
        [
          "content mismatch",
          "inventoried symlink",
          "unsupported launcher synchronization",
          "live executor",
          "helper changed",
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
    if (failure === "helper changed") {
      fs.appendFileSync(resolvePackageActivationHelper(f.anchor), "// changed\n");
    }
    if (failure === "wrong version") {
      fs.writeFileSync(
        path.join(f.packageRoot, "dist/build-info.json"),
        JSON.stringify({ version: "1.0.0" }),
      );
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
              : failure === "helper changed"
                ? /helper/iu
                : /version/iu,
      );
    }
    expect(fs.readFileSync(resolvePackageActivationJournalPath(f.anchor))).toEqual(journal);
    expect(fs.existsSync(f.anchor)).toBe(true);
    expect(mocks.finalize).not.toHaveBeenCalled();
  });

  it.each(["current", "legacy launcher group"] as const)(
    "retires an untouched prepared publication and admits the next update: %s",
    async (shape) => {
      const f = shape === "current" ? await fixtures.prepare() : await preparedOwnershipMismatch();
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

  it.each(supersessionReasons)(
    "%s preserves evidence and admits the next package preparation",
    async (reason) => {
      const f = await preparedOwnershipMismatch();
      const replacementIdentity = await obsoleteRecovery(f, reason);
      const launcher = fs.lstatSync(f.launcher);
      expect(() => assertNoPendingPackageActivation(f.packageRoot)).toThrow();

      await repair();

      expect(openPackageActivationJournal(f.anchor).read()).toMatchObject({
        phase: "superseded",
        intent: { kind: reason, replacementIdentity, settled: true },
        descriptor: f.descriptor,
      });
      expect(readPackageActivationReceipt(f.packageRoot)).toMatchObject({ phase: "complete" });
      expect(() => assertNoPendingPackageActivation(f.packageRoot)).not.toThrow();
      expect(fs.existsSync(f.anchor)).toBe(false);
      expect(fs.existsSync(f.helper)).toBe(false);
      expect(packageActivationIdentity(f.retained, true)).toBe(f.descriptor.anchorIdentity);
      expect(packageActivationIdentity(path.join(f.retained, "recovery.mjs"), false)).toBe(
        f.descriptor.helperIdentity,
      );
      expect(fs.readFileSync(path.join(f.retained, "recovery.mjs"))).toEqual(f.helperBytes);
      expect(packageActivationIdentity(path.join(f.retained, "candidate"), true)).toBe(
        f.descriptor.candidate.identity,
      );
      expect(packageActivationIdentity(f.packageRoot, true)).toBe(replacementIdentity);
      expect(fs.lstatSync(f.launcher).ino).toBe(launcher.ino);
      expect(fs.readlinkSync(f.launcher)).toBe("../lib/node_modules/openclaw/openclaw.mjs");
      expect(defaultRuntime.error).toHaveBeenCalledWith(
        expect.stringContaining(`previous package update operation ${f.operationId}`),
      );
      expect(vi.mocked(defaultRuntime.error).mock.calls.flat().join("\n")).toContain(reason);
      expect(mocks.finalize).toHaveBeenCalledOnce();
      expect(vi.mocked(defaultRuntime.error).mock.calls.flat().join("\n")).toContain(f.retained);

      await prepareNextPackage(f, "4.0.0");
      const next = openPackageActivationJournal(f.anchor).read();
      expect(next.phase).toBe("prepared");
      expect(next.descriptor.operationId).not.toBe(f.operationId);
      expect(fs.readFileSync(path.join(f.retained, "recovery.mjs"))).toEqual(f.helperBytes);
    },
  );

  it.each(["previous", "candidate"] as const)(
    "preserves original recovery when the recorded %s package is still installed",
    async (selected) => {
      const f = await preparedOwnershipMismatch();
      if (selected === "candidate") {
        fs.renameSync(f.packageRoot, `${f.packageRoot}.previous`);
        fs.renameSync(path.join(f.anchor, "candidate"), f.packageRoot);
      } else {
        fs.unlinkSync(f.launcher);
        fs.symlinkSync("../lib/node_modules/foreign/openclaw.mjs", f.launcher);
      }
      const journal = fs.readFileSync(f.journal);

      await expect(repair()).rejects.toThrow(/publication|recovery/iu);

      expect(fs.readFileSync(f.journal)).toEqual(journal);
      expect(fs.readFileSync(f.helper)).toEqual(f.helperBytes);
      expect(fs.existsSync(f.retained)).toBe(false);
      expect(mocks.finalize).not.toHaveBeenCalled();
    },
  );

  it.each(
    (["superseded-by-manual-install", "recovery-lease-missing"] as const).flatMap((reason) =>
      (["anchor", "helper"] as const).map((boundary) => ({ reason, boundary })),
    ),
  )(
    "resumes $reason after losing the $boundary rename acknowledgement",
    async ({ reason, boundary }) => {
      const f = await preparedOwnershipMismatch();
      await obsoleteRecovery(f, reason);
      const rename = fsp.rename.bind(fsp);
      const interruption = vi
        .spyOn(fsp, "rename")
        .mockImplementation(async (source, destination) => {
          await rename(source, destination);
          if (source === (boundary === "anchor" ? f.anchor : f.helper)) {
            throw new Error("archive acknowledgement interrupted");
          }
        });
      await expect(repair()).rejects.toThrow("archive acknowledgement interrupted");
      interruption.mockRestore();
      expect(openPackageActivationJournal(f.anchor).read()).toMatchObject({
        phase: "superseded",
        intent: { kind: reason, settled: false },
      });
      expect(() => assertNoPendingPackageActivation(f.packageRoot)).toThrow();

      if (reason === "recovery-lease-missing") {
        // Model inode reuse deterministically, including on filesystems that
        // happen to allocate a different inode for the recreated lease store.
        const { descriptor } = openPackageActivationJournal(f.anchor).read();
        descriptor.authority.databaseIdentity = packageActivationIdentity(
          descriptor.authority.databasePath,
          false,
        );
        const db = new DatabaseSync(f.journal);
        try {
          db.prepare("UPDATE package_activation SET descriptor_json = ?").run(
            JSON.stringify(descriptor),
          );
        } finally {
          db.close();
        }
      }

      await repair();

      expect(openPackageActivationJournal(f.anchor).read().intent).toMatchObject({
        kind: reason,
        settled: true,
      });
      expect(readPackageActivationReceipt(f.packageRoot)).toMatchObject({ phase: "complete" });
      expect(() => assertNoPendingPackageActivation(f.packageRoot)).not.toThrow();
      expect(fs.readFileSync(path.join(f.retained, "recovery.mjs"))).toEqual(f.helperBytes);
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

  it.each(supersessionReasons)(
    "does not settle %s while another executor owns the installation",
    async (reason) => {
      const f = await preparedOwnershipMismatch();
      await obsoleteRecovery(f, reason);
      const journal = fs.readFileSync(f.journal);

      await withUpdateCommandExecutor(randomUUID(), async (executor) => {
        await executor.enter(f.packageRoot);
        await expect(repair()).rejects.toThrow(/executor.*owns|update.*owns/iu);
      });

      expect(fs.readFileSync(f.journal)).toEqual(journal);
      expect(fs.readFileSync(f.helper)).toEqual(f.helperBytes);
      expect(fs.existsSync(f.retained)).toBe(false);
      expect(mocks.finalize).not.toHaveBeenCalled();
    },
  );

  it("retains the original replacement fact when the live installation changes during archival", async () => {
    const f = await preparedOwnershipMismatch();
    const replacementIdentity = await manualInstall(f);
    const rename = fsp.rename.bind(fsp);
    const replacement = vi.spyOn(fsp, "rename").mockImplementation(async (source, destination) => {
      await rename(source, destination);
      if (source === f.anchor) {
        fs.renameSync(f.packageRoot, `${f.packageRoot}.replaced-again`);
        await writePackageRoot(f.packageRoot, "4.0.0");
      }
    });

    await expect(repair()).rejects.toThrow(/changed/iu);
    replacement.mockRestore();

    expect(openPackageActivationJournal(f.anchor).read()).toMatchObject({
      phase: "superseded",
      intent: { kind: "superseded-by-manual-install", replacementIdentity },
    });
    expect(packageActivationIdentity(f.packageRoot, true)).not.toBe(replacementIdentity);
    expect(fs.readFileSync(path.join(f.packageRoot, "package.json"), "utf8")).toContain("4.0.0");
    expect(() => assertNoPendingPackageActivation(f.packageRoot)).toThrow();
    expect(mocks.finalize).not.toHaveBeenCalled();

    await repair();

    expect(openPackageActivationJournal(f.anchor).read()).toMatchObject({
      phase: "superseded",
      intent: { kind: "superseded-by-manual-install", replacementIdentity, settled: true },
    });
    expect(() => assertNoPendingPackageActivation(f.packageRoot)).not.toThrow();
  });
});
