import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  resolvePackageActivationAnchor,
  resolvePackageActivationJournalPath,
} from "./package-update-activation-paths.js";
import { readImmutableInstallRecord } from "./update-immutable-install-record.js";
import { immutableLayout } from "./update-immutable-layout.test-support.js";

const mocks = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock("./sqlite-readonly-worker.js", async (original) => ({
  ...(await original<typeof import("./sqlite-readonly-worker.js")>()),
  runSqliteReadOnlyOperation: mocks.read,
}));
const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

it.each(["malformed", "unreadable"])(
  "rejects a %s recorded build identity instead of treating it as absent",
  async (kind) => {
    const descriptor = immutableLayout(dirs.make("immutable-record-"), {
      sha: "a".repeat(40),
      buildDigest: "b".repeat(64),
      unit: "fixture.service",
      account: "fixture",
    });
    const journal = resolvePackageActivationJournalPath(
      resolvePackageActivationAnchor(descriptor.root),
    );
    await fs.mkdir(path.dirname(journal), { recursive: true });
    await fs.writeFile(journal, "read boundary fixture");
    mocks.read.mockResolvedValue({
      revision: 0,
      descriptor: { ...descriptor, build: null },
      prepared: null,
    });
    if (kind === "unreadable") {
      mocks.read.mockRejectedValueOnce(new Error("Descriptor is unreadable"));
    }
    await expect(readImmutableInstallRecord(descriptor.root)).rejects.toThrow(
      kind === "unreadable" ? "Descriptor is unreadable" : "build",
    );
  },
);
