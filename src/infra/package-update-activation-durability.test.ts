import { randomUUID } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withUpdateCommandExecutor } from "../cli/update-cli/update-command-executor.js";
import * as runtimePaths from "../daemon/runtime-paths.js";
import * as durability from "./directory-durability.js";
import {
  openPackageActivationJournal,
  resolvePackageActivationControl as control,
  resolvePackageActivationJournalPath as journalPath,
  resolvePackageActivationHelper as helperPath,
} from "./package-update-activation-journal.js";
import { createPackageActivationLifetimeFixture } from "./package-update-activation-lifetime.test-support.js";
import {
  capturePackageActivationRuntime,
  resolvePackageActivationAnchor,
} from "./package-update-activation-paths.js";
import { preparePackageActivationJournal } from "./package-update-activation-prepare.js";
import {
  readPackageActivationStatus as status,
  runPackageActivationRecovery as recovery,
} from "./package-update-activation.js";
import { createPackageIntegrityReader } from "./package-update-integrity.js";
import { createPackageSwapFixture } from "./package-update-swap.test-support.js";

const fixture = createPackageActivationLifetimeFixture();
let root: string;
let anchor: string;
beforeEach(() => {
  ({ root } = fixture.setup());
  anchor = "";
});
afterEach(async () => {
  try {
    await fixture.lifetime.cleanup();
  } finally {
    vi.restoreAllMocks();
  }
});

const prepare = (custody?: (retained: boolean) => void) =>
  fixture.prepare((value) => {
    anchor = value;
  }, custody);
const readJournal = (location = anchor) => openPackageActivationJournal(location).read();
const absent = (...files: string[]) =>
  files.forEach((file) => expect(fs.existsSync(file)).toBe(false));
const oldPackage = (directory: string) =>
  expect(fs.readFileSync(path.join(directory, "package.json"), "utf8")).toContain(
    '"version":"1.0.0"',
  );
const complete = (result: ReturnType<typeof recovery>) =>
  expect(result).resolves.toMatchObject({ phase: "complete" });
function expectHelperUnlink(location: string) {
  const record = readJournal(location);
  expect(record).toMatchObject({
    phase: "anchor-retired",
    intent: { kind: "unlink-helper", identity: record.descriptor.helperIdentity },
  });
}
async function recover(location: string) {
  const { operationId } = readJournal(location).descriptor;
  await expect(recovery(location, "repair", operationId)).resolves.toMatchObject({
    phase: "aborted",
  });
  await complete(recovery(location, "retire", operationId));
  absent(location, helperPath(location));
}

describe.skipIf(process.platform === "win32")("package preparation durability", () => {
  it.each(["before-probe", "during-probe", "unsupported-bun"] as const)(
    "refuses %s runtime before custody",
    async (cut) => {
      const f = await createPackageSwapFixture(root);
      const executable = path.join(root, "selected-runtime");
      fs.writeFileSync(executable, "fixture runtime", { mode: 0o700 });
      const runtime = capturePackageActivationRuntime("bun", executable);
      if (cut === "before-probe") {
        fs.renameSync(executable, `${executable}.previous`);
        fs.writeFileSync(executable, "fixture runtime", { mode: 0o700 });
      }
      vi.spyOn(runtimePaths, "resolveBunRuntimeInfo").mockImplementation(async () => {
        if (cut === "during-probe") {
          fs.writeFileSync(executable, "changed runtime executable");
        }
        return {
          status: cut === "unsupported-bun" ? "unsupported" : "supported",
          version: cut === "unsupported-bun" ? "1.3.0" : "1.4.3",
          sqliteVersion: "3.53.4",
          sqliteProbe: {
            available: true,
            version: "3.53.4",
            text: true,
            blob: true,
            json: true,
          },
          nodeSharedSqlite: false,
        };
      });
      anchor = resolvePackageActivationAnchor(f.packageRoot);
      const onPrepared = vi.fn();
      const onCustody = vi.fn();
      const reader = createPackageIntegrityReader();
      const previous = await reader.tree(f.packageRoot);
      const candidate = await reader.tree(f.params.stage.packageRoot);
      await withUpdateCommandExecutor(randomUUID(), async (executor) => {
        await expect(
          preparePackageActivationJournal({
            options: { fence: await executor.enter(f.packageRoot), runtime, onPrepared },
            liveRoot: f.packageRoot,
            stageRoot: f.params.stage.packageRoot,
            launcherRoot: f.params.stage.layout.binDir,
            binDir: path.dirname(f.launcher),
            previous,
            onCustody,
            launchers: [],
          }),
        ).rejects.toThrow(
          cut === "unsupported-bun"
            ? "supported external Bun executable"
            : "changed after runtime preflight",
        );
      });
      expect(onPrepared).not.toHaveBeenCalled();
      expect(onCustody).not.toHaveBeenCalled();
      absent(anchor, control(anchor));
      expect(await reader.tree(f.packageRoot)).toEqual(previous);
      expect(await reader.tree(f.params.stage.packageRoot)).toEqual(candidate);
      expect(fs.readFileSync(f.launcher, "utf8")).toBe("old launcher\n");
    },
  );

  it.each([
    "anchor-before",
    "anchor-after",
    "anchor-sync",
    "helper-before",
    "helper-after",
    "helper-sync",
  ])("recovers the exact %s terminal cut", async (cut) => {
    const f = await fixture.prepare();
    await recovery(f.anchor, "repair", f.operationId);
    const helper = helperPath(f.anchor);
    const [target, moment] = cut.split("-");
    const removed = target === "anchor" ? f.anchor : helper;
    const read = () => readJournal(f.anchor);
    const retire = () => recovery(f.anchor, "retire", f.operationId);
    const inspect = () => status(f.anchor, f.operationId);
    const failure = new Error(cut);
    const rmdir = fsp.rmdir.bind(fsp),
      unlink = fsp.unlink.bind(fsp);
    let refuseSync = true,
      anchorSyncRefusals = 0;
    let helperSync: durability.DirectorySyncOutcome | undefined;
    const remove = async (
      kind: "anchor" | "helper",
      file: unknown,
      effect: () => Promise<void>,
    ) => {
      if (kind === target && file === removed && moment !== "sync") {
        if (target === "helper") {
          expectHelperUnlink(f.anchor);
        }
        if (moment === "after") {
          await effect();
        }
        throw failure;
      }
      await effect();
    };
    vi.spyOn(fsp, "rmdir").mockImplementation((file, ...args) =>
      remove("anchor", file, () => rmdir(file, ...args)),
    );
    vi.spyOn(fsp, "unlink").mockImplementation((file) =>
      remove("helper", file, () => unlink(file)),
    );
    const sync = durability.syncDirectory;
    const syncSpy = vi.spyOn(durability, "syncDirectory").mockImplementation(async (directory) => {
      if (moment === "sync" && directory === path.dirname(removed) && !fs.existsSync(removed)) {
        if (target === "anchor") {
          expect(read()).toMatchObject({
            phase: "retiring",
            intent: { kind: "remove-anchor", selected: "previous" },
          });
        } else {
          expectHelperUnlink(f.anchor);
        }
        if (refuseSync) {
          if (target === "anchor") {
            anchorSyncRefusals++;
          }
          throw target === "helper" ? Object.assign(failure, { code: "EIO" }) : failure;
        }
        const result = await sync(directory);
        if (target === "helper") {
          helperSync = result;
        }
        return result;
      }
      return sync(directory);
    });
    await expect(retire()).rejects.toBe(failure);
    vi.mocked(fsp.rmdir).mockRestore();
    vi.mocked(fsp.unlink).mockRestore();
    if (moment === "sync") {
      const pending = read();
      if (cut === "anchor-sync") {
        expect(fs.existsSync(f.anchor)).toBe(false);
        expect(fs.existsSync(helper)).toBe(true);
      }
      await expect(retire()).rejects.toBe(failure);
      if (cut === "helper-sync") {
        await complete(inspect());
      } else {
        expect(anchorSyncRefusals).toBe(2);
      }
      expect(read()).toEqual(pending);
      refuseSync = false;
    }
    await complete(retire());
    if (cut === "helper-sync") {
      expect(helperSync).toEqual({ status: "synced" });
    } else if (cut === "anchor-sync") {
      absent(helper);
      oldPackage(f.packageRoot);
    }
    syncSpy.mockRestore();
    await complete(inspect());
    absent(f.anchor);
  });

  it.each(["source", "destination"] as const)("retries unpersisted %s custody", async (side) => {
    const failure = new Error("directory persistence failed");
    const sync = durability.syncDirectory;
    let refused = 0;
    const spy = vi.spyOn(durability, "syncDirectory").mockImplementation(async (directory) => {
      if (anchor && fs.existsSync(path.join(anchor, "candidate"))) {
        const record = readJournal();
        const candidate = record.descriptor.preparation.find(
          (entry) => entry.name === "candidate",
        )!;
        const parent = side === "source" ? path.dirname(candidate.source) : anchor;
        if (
          directory === parent &&
          record.intent?.kind === "prepare" &&
          record.intent.moving === "candidate"
        ) {
          expect(record.intent.completed).not.toContain("candidate");
          expect(fs.existsSync(candidate.source)).toBe(false);
          refused++;
          throw failure;
        }
      }
      return sync(directory);
    });
    await expect(prepare()).rejects.toBe(failure);
    const journal = openPackageActivationJournal(anchor);
    const before = journal.read();
    expect(before).toMatchObject({
      phase: "preparing",
      intent: { kind: "prepare", moving: "candidate" },
    });
    // The rename has already happened. Reconciliation must still require its
    // durability and leave the completion row unchanged on another failure.
    await expect(recovery(anchor, "repair", before.descriptor.operationId)).rejects.toBe(failure);
    expect(refused).toBe(2);
    expect(journal.read()).toEqual(before);
    spy.mockRestore();
    await recover(anchor);
    oldPackage(before.descriptor.authority.installKey);
  });

  it.each(["private", "published"] as const)("handles %s control sync failure", async (cut) => {
    const failure = new Error("control persistence failed");
    const custody = vi.fn();
    const sync = durability.syncDirectorySync;
    const spy = vi.spyOn(durability, "syncDirectorySync").mockImplementation((directory) => {
      if (
        anchor &&
        ((cut === "private" &&
          typeof directory === "string" &&
          path.basename(directory).startsWith(".activation-control-")) ||
          (cut === "published" &&
            directory === path.dirname(anchor) &&
            fs.existsSync(control(anchor))))
      ) {
        throw failure;
      }
      return sync(directory);
    });
    await expect(prepare(custody)).rejects.toBe(failure);
    spy.mockRestore();
    if (cut === "private") {
      expect(custody).not.toHaveBeenCalled();
      absent(control(anchor));
    } else {
      expect(custody.mock.calls).toEqual([[true]]);
      expect(readJournal().phase).toBe("preparing");
      await recover(anchor);
    }
  });

  it.each([false, true])("rejects unpersisted helper (replacement=%s)", async (replacement) => {
    const first = replacement ? await fixture.prepare() : undefined;
    if (first) {
      await recover(first.anchor);
    }
    const before = first && readJournal(first.anchor);
    const previousReceipt = first && fs.readFileSync(journalPath(first.anchor));
    let helperFd: number | undefined;
    let helperIdentity: fs.BigIntStats | undefined;
    const open = fs.openSync;
    const sync = fs.fsyncSync;
    const failure = new Error("helper persistence failed");
    const custody = vi.fn();
    vi.spyOn(fs, "openSync").mockImplementation((file, ...args) => {
      const fd = open(file, ...args);
      if (String(file).endsWith(".mjs") && String(file).includes(".activation-")) {
        helperFd = fd;
        helperIdentity = fs.fstatSync(fd, { bigint: true });
      }
      return fd;
    });
    vi.spyOn(fs, "fsyncSync").mockImplementation((fd) => {
      if (fd === helperFd && helperIdentity) {
        const current = fs.fstatSync(fd, { bigint: true });
        // A closed helper fd can be reused by unrelated cleanup writes.
        if (current.dev === helperIdentity.dev && current.ino === helperIdentity.ino) {
          throw failure;
        }
      }
      sync(fd);
    });
    await expect(prepare(custody)).rejects.toBe(failure);
    expect(helperFd).toBeTypeOf("number");
    expect(() => fs.fstatSync(helperFd!)).toThrow();
    expect(custody).not.toHaveBeenCalled();
    if (before) {
      expect(
        fs.readFileSync(
          `${anchor}.superseded-${before.descriptor.operationId}/control/operation.sqlite`,
        ),
      ).toEqual(previousReceipt);
    }
    absent(control(anchor));
  });
});
