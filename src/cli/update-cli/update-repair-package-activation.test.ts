import { randomUUID } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
} from "../../infra/package-update-activation.js";
import { createPackageIntegrityReader } from "../../infra/package-update-integrity.js";
import { writePackageRoot } from "../../infra/package-update-steps.test-support.js";
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
beforeEach(async () => {
  vi.clearAllMocks();
  fixtures.setup();
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
] as const;

async function obsoleteRecovery(
  f: Awaited<ReturnType<typeof preparedOwnershipMismatch>>,
  reason: (typeof supersessionReasons)[number],
) {
  if (reason === "superseded-by-manual-install") {
    return manualInstall(f);
  }
  const databasePath = f.descriptor.authority.databasePath;
  fs.renameSync(databasePath, `${databasePath}.previous`);
  fs.copyFileSync(`${databasePath}.previous`, databasePath);
  fs.chmodSync(databasePath, 0o600);
  return packageActivationIdentity(f.packageRoot, true);
}

async function repair() {
  await updateRepairCommand({ json: true, yes: true });
}

describe.skipIf(process.platform === "win32")("public package repair of obsolete recovery", () => {
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

      await writePackageRoot(f.params.stage.packageRoot, "4.0.0");
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
      }
      const journal = fs.readFileSync(f.journal);

      await expect(repair()).rejects.toThrow(/publication|recovery/iu);

      expect(fs.readFileSync(f.journal)).toEqual(journal);
      expect(fs.readFileSync(f.helper)).toEqual(f.helperBytes);
      expect(fs.existsSync(f.retained)).toBe(false);
      expect(mocks.finalize).not.toHaveBeenCalled();
    },
  );

  it.each(["anchor", "helper"] as const)(
    "resumes supersession after losing the %s rename acknowledgement",
    async (boundary) => {
      const f = await preparedOwnershipMismatch();
      await manualInstall(f);
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
        intent: { kind: "superseded-by-manual-install", settled: false },
      });
      expect(() => assertNoPendingPackageActivation(f.packageRoot)).toThrow();

      await repair();

      expect(readPackageActivationReceipt(f.packageRoot)).toMatchObject({ phase: "complete" });
      expect(() => assertNoPendingPackageActivation(f.packageRoot)).not.toThrow();
      expect(fs.readFileSync(path.join(f.retained, "recovery.mjs"))).toEqual(f.helperBytes);
    },
  );

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
