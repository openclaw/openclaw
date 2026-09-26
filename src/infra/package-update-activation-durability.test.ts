import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as durability from "./directory-durability.js";
import {
  openPackageActivationJournal,
  resolvePackageActivationControl,
  resolvePackageActivationHelper,
} from "./package-update-activation-journal.js";
import { createPackageActivationLifetimeFixture } from "./package-update-activation-lifetime.test-support.js";
import { runPackageActivationRecovery } from "./package-update-activation.js";

const fixture = createPackageActivationLifetimeFixture();
beforeEach(() => fixture.setup());
afterEach(async () => {
  try {
    await fixture.lifetime.cleanup();
  } finally {
    vi.restoreAllMocks();
  }
});

async function recover(anchor: string) {
  const { operationId } = openPackageActivationJournal(anchor).read().descriptor;
  await expect(runPackageActivationRecovery(anchor, "repair", operationId)).resolves.toMatchObject({
    phase: "aborted",
  });
  await expect(runPackageActivationRecovery(anchor, "retire", operationId)).resolves.toMatchObject({
    phase: "complete",
  });
  expect(fs.existsSync(anchor)).toBe(false);
  expect(fs.existsSync(resolvePackageActivationHelper(anchor))).toBe(false);
}

describe.skipIf(process.platform === "win32")("package preparation durability", () => {
  it("keeps anchor removal resumable until its parent is persisted", async () => {
    const f = await fixture.prepare();
    await runPackageActivationRecovery(f.anchor, "repair", f.operationId);
    const journal = openPackageActivationJournal(f.anchor);
    const failure = new Error("anchor removal persistence failed");
    const sync = durability.syncDirectory;
    let refused = 0;
    const spy = vi.spyOn(durability, "syncDirectory").mockImplementation(async (directory) => {
      if (directory === path.dirname(f.anchor) && !fs.existsSync(f.anchor)) {
        expect(journal.read()).toMatchObject({
          phase: "retiring",
          intent: { kind: "remove-anchor", selected: "previous" },
        });
        refused++;
        throw failure;
      }
      return sync(directory);
    });
    await expect(runPackageActivationRecovery(f.anchor, "retire", f.operationId)).rejects.toBe(
      failure,
    );
    const pending = journal.read();
    expect(fs.existsSync(f.anchor)).toBe(false);
    expect(fs.existsSync(resolvePackageActivationHelper(f.anchor))).toBe(true);
    // An already absent anchor still requires the failed durability step on resume.
    await expect(runPackageActivationRecovery(f.anchor, "retire", f.operationId)).rejects.toBe(
      failure,
    );
    expect(journal.read()).toEqual(pending);
    expect(refused).toBe(2);
    spy.mockRestore();
    await expect(
      runPackageActivationRecovery(f.anchor, "retire", f.operationId),
    ).resolves.toMatchObject({ phase: "complete" });
    expect(fs.existsSync(resolvePackageActivationHelper(f.anchor))).toBe(false);
    expect(fs.readFileSync(path.join(f.packageRoot, "package.json"), "utf8")).toContain(
      '"version":"1.0.0"',
    );
  });

  it.each(["source", "destination"] as const)(
    "retains and retries custody when the %s parent cannot be persisted",
    async (side) => {
      let anchor = "";
      const failure = new Error("directory persistence failed");
      const sync = durability.syncDirectory;
      let refused = 0;
      const spy = vi.spyOn(durability, "syncDirectory").mockImplementation(async (directory) => {
        if (anchor && fs.existsSync(path.join(anchor, "candidate"))) {
          const record = openPackageActivationJournal(anchor).read();
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
      await expect(
        fixture.prepare((value) => {
          anchor = value;
        }),
      ).rejects.toBe(failure);
      const journal = openPackageActivationJournal(anchor);
      const before = journal.read();
      expect(before.phase).toBe("preparing");
      expect(before.intent).toMatchObject({ kind: "prepare", moving: "candidate" });
      // The rename has already happened. Reconciliation must still require its
      // durability and leave the completion row unchanged on another failure.
      await expect(
        runPackageActivationRecovery(anchor, "repair", before.descriptor.operationId),
      ).rejects.toBe(failure);
      expect(refused).toBe(2);
      expect(journal.read()).toEqual(before);
      spy.mockRestore();
      await recover(anchor);
      expect(
        fs.readFileSync(path.join(before.descriptor.authority.installKey, "package.json"), "utf8"),
      ).toContain('"version":"1.0.0"');
    },
  );

  it.each(["private", "published"] as const)(
    "retains safe cleanup custody after %s control directory sync failure",
    async (cut) => {
      let anchor = "";
      const failure = new Error("control persistence failed");
      const custody = vi.fn();
      const sync = durability.syncDirectorySync;
      let refused = false;
      const spy = vi.spyOn(durability, "syncDirectorySync").mockImplementation((directory) => {
        if (
          anchor &&
          ((cut === "private" &&
            typeof directory === "string" &&
            path.basename(directory).startsWith(".activation-control-")) ||
            (cut === "published" &&
              directory === path.dirname(anchor) &&
              fs.existsSync(resolvePackageActivationControl(anchor))))
        ) {
          refused = true;
          throw failure;
        }
        return sync(directory);
      });
      await expect(
        fixture.prepare((value) => {
          anchor = value;
        }, custody),
      ).rejects.toBe(failure);
      expect(refused).toBe(true);
      spy.mockRestore();
      if (cut === "private") {
        expect(custody).not.toHaveBeenCalled();
        expect(fs.existsSync(resolvePackageActivationControl(anchor))).toBe(false);
      } else {
        expect(custody.mock.calls).toEqual([[true]]);
        expect(openPackageActivationJournal(anchor).read().phase).toBe("preparing");
        await recover(anchor);
      }
    },
  );

  it.each([false, true])(
    "does not record an unpersisted helper (replacement=%s)",
    async (replacement) => {
      const first = replacement ? await fixture.prepare() : undefined;
      if (first) {
        await recover(first.anchor);
      }
      const before = first ? openPackageActivationJournal(first.anchor).read() : undefined;
      let anchor = "";
      let helperFd: number | undefined;
      const open = fs.openSync;
      const sync = fs.fsyncSync;
      const failure = new Error("helper persistence failed");
      const custody = vi.fn();
      vi.spyOn(fs, "openSync").mockImplementation((file, ...args) => {
        const fd = open(file, ...args);
        if (String(file).endsWith(".mjs") && String(file).includes(".activation-")) {
          helperFd = fd;
        }
        return fd;
      });
      vi.spyOn(fs, "fsyncSync").mockImplementation((fd) => {
        if (fd === helperFd) {
          throw failure;
        }
        sync(fd);
      });
      await expect(
        fixture.prepare((value) => {
          anchor = value;
        }, custody),
      ).rejects.toBe(failure);
      expect(helperFd).toBeTypeOf("number");
      expect(() => fs.fstatSync(helperFd!)).toThrow();
      expect(custody).not.toHaveBeenCalled();
      if (before) {
        expect(openPackageActivationJournal(anchor).read()).toEqual(before);
      } else {
        expect(fs.existsSync(resolvePackageActivationControl(anchor))).toBe(false);
      }
    },
  );
});
