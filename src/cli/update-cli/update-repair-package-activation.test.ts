import { randomUUID } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  openPackageActivationJournal,
  packageActivationIdentity,
  resolvePackageActivationHelper,
  resolvePackageActivationJournalPath,
} from "../../infra/package-update-activation-journal.js";
import { createPackageActivationLifetimeFixture } from "../../infra/package-update-activation-lifetime.test-support.js";
import {
  assertNoPendingPackageActivation,
  readPackageActivationReceipt,
} from "../../infra/package-update-activation.js";
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
    label: "repair-untouched-activation",
    env: { OPENCLAW_UPDATE_RUN_ID: undefined },
  });
  await state.writeConfig({ plugins: { enabled: false } });
  vi.spyOn(defaultRuntime, "error").mockImplementation(() => undefined);
  mocks.finalize.mockImplementation(async () => {
    assertNoPendingPackageActivation(await mocks.root());
  });
});
afterEach(async () => {
  try {
    await state.cleanup();
    await fixtures.lifetime.cleanup();
  } finally {
    vi.restoreAllMocks();
  }
});

function changeJournal(anchor: string, phase: string, intent = "null", publications = "[]") {
  const database = new DatabaseSync(resolvePackageActivationJournalPath(anchor));
  try {
    database
      .prepare(
        "UPDATE package_activation SET revision = revision + 1, phase = ?, intent_json = ?, publications_json = ?",
      )
      .run(phase, intent, publications);
  } finally {
    database.close();
  }
}

const repair = () => updateRepairCommand({ json: true, yes: true });

describe.skipIf(process.platform === "win32")(
  "public repair of untouched package preparation",
  () => {
    it.each(["prepared", "aborted"] as const)(
      "retires %s preparation without changing the live package or launcher",
      async (phase) => {
        const f = await fixtures.prepare();
        mocks.root.mockResolvedValue(f.packageRoot);
        if (phase === "aborted") {
          changeJournal(f.anchor, phase);
        }
        const prepared = openPackageActivationJournal(f.anchor).read();
        expect(prepared).toMatchObject({ phase, intent: null, publications: [] });
        const launcher = fs.lstatSync(f.launcher);
        const launcherBytes = fs.readFileSync(f.launcher);
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
        expect(fs.readFileSync(f.launcher)).toEqual(launcherBytes);
        expect(defaultRuntime.error).toHaveBeenCalledWith(
          expect.stringContaining("publication-not-started"),
        );
        expect(mocks.finalize).toHaveBeenCalledOnce();

        const next = await fixtures.prepare();
        const nextRecord = openPackageActivationJournal(next.anchor).read();
        expect(nextRecord.phase).toBe("prepared");
        expect(nextRecord.descriptor.operationId).not.toBe(f.operationId);
      },
    );

    it.each([
      "pending intent",
      "publication receipt",
      "rollback in progress",
      "previous package bytes",
      "foreign package generation",
      "helper bytes",
      "foreign lease database",
    ] as const)("preserves recovery evidence after %s", async (change) => {
      const f = await fixtures.prepare();
      mocks.root.mockResolvedValue(f.packageRoot);
      const record = openPackageActivationJournal(f.anchor).read();
      if (change === "pending intent") {
        changeJournal(f.anchor, "prepared", JSON.stringify({ kind: "displace" }));
      } else if (change === "publication receipt") {
        changeJournal(
          f.anchor,
          "prepared",
          "null",
          JSON.stringify([
            { name: "openclaw", identity: record.descriptor.launchers[0]!.candidateIdentity },
          ]),
        );
      } else if (change === "rollback in progress") {
        changeJournal(f.anchor, "rollback-in-progress");
      } else if (change === "previous package bytes") {
        fs.appendFileSync(path.join(f.packageRoot, "package.json"), "\n");
      } else if (change === "foreign package generation") {
        fs.renameSync(f.packageRoot, `${f.packageRoot}.foreign`);
        fs.cpSync(`${f.packageRoot}.foreign`, f.packageRoot, { recursive: true });
      } else if (change === "helper bytes") {
        fs.appendFileSync(resolvePackageActivationHelper(f.anchor), "// changed\n");
      } else {
        const database = record.descriptor.authority.databasePath;
        fs.renameSync(database, `${database}.foreign`);
        fs.copyFileSync(`${database}.foreign`, database);
        fs.chmodSync(database, 0o600);
      }
      const journalBytes = fs.readFileSync(resolvePackageActivationJournalPath(f.anchor));
      const helperBytes = fs.readFileSync(resolvePackageActivationHelper(f.anchor));

      await expect(repair()).rejects.toThrow(/package|publication|recovery|lease/iu);

      expect(fs.readFileSync(resolvePackageActivationJournalPath(f.anchor))).toEqual(journalBytes);
      expect(fs.readFileSync(resolvePackageActivationHelper(f.anchor))).toEqual(helperBytes);
      expect(fs.existsSync(f.anchor)).toBe(true);
    });

    it("refuses an intervening journal generation before retirement", async () => {
      const f = await fixtures.prepare();
      mocks.root.mockResolvedValue(f.packageRoot);
      const helper = resolvePackageActivationHelper(f.anchor);
      const read = fsp.readFile.bind(fsp);
      let intervened = false;
      vi.spyOn(fsp, "readFile").mockImplementation(async (file, options) => {
        const bytes = await read(file, options);
        if (file === helper && !intervened) {
          intervened = true;
          changeJournal(f.anchor, "rollback-in-progress");
        }
        return bytes;
      });
      await expect(repair()).rejects.toThrow(/publication|recovery|journal/iu);
      expect(intervened).toBe(true);
      expect(openPackageActivationJournal(f.anchor).read().phase).toBe("rollback-in-progress");
      expect(fs.existsSync(f.anchor)).toBe(true);
      expect(fs.existsSync(helper)).toBe(true);
      expect(mocks.finalize).not.toHaveBeenCalled();
    });

    it("does not take over another executor's live installation lease", async () => {
      const f = await fixtures.prepare();
      mocks.root.mockResolvedValue(f.packageRoot);
      const journalBytes = fs.readFileSync(resolvePackageActivationJournalPath(f.anchor));
      await withUpdateCommandExecutor(randomUUID(), async (executor) => {
        const foreign = await executor.enter(f.packageRoot);
        await expect(repair()).rejects.toThrow(/executor|owns|publication|recovery/iu);
        foreign.assertCurrent();
      });
      expect(fs.readFileSync(resolvePackageActivationJournalPath(f.anchor))).toEqual(journalBytes);
      expect(fs.existsSync(resolvePackageActivationHelper(f.anchor))).toBe(true);
    });
  },
);
