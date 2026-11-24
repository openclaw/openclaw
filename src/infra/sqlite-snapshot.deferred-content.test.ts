import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { cleanupSnapshotOperations } from "./sqlite-readonly-location-cleanup.js";
import { assertDeferredSqliteContent } from "./sqlite-snapshot-file.js";
import {
  exclusiveCopyPublication,
  snapshotContent,
  useSnapshotFixture,
  type PublicationFixture,
} from "./sqlite-snapshot.test-support.js";
const state = vi.hoisted(() => ({
  transfer: undefined as PublicationFixture | undefined,
  finalTransfer: undefined as PublicationFixture | undefined,
}));
vi.mock("@openclaw/fs-safe/durability", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@openclaw/fs-safe/durability")>();
  return {
    ...actual,
    publishFileExclusive: async (...args: Parameters<typeof actual.publishFileExclusive>) => {
      const staging = path
        .basename(path.dirname(args[0].targetPath))
        .startsWith(".sqlite-publish-");
      const transfer = staging ? state.transfer : state.finalTransfer;
      return transfer
        ? transfer(args[0], actual.publishFileExclusive)
        : actual.publishFileExclusive(...args);
    },
  };
});
const fixture = useSnapshotFixture();
afterEach(async () => {
  state.transfer = state.finalTransfer = undefined;
  vi.restoreAllMocks();
  await cleanupSnapshotOperations();
});
function seed() {
  fixture.execSource(
    "CREATE TABLE records (payload BLOB); INSERT INTO records VALUES (zeroblob(65536));",
  );
}
async function corrupt(file: string) {
  await using handle = await fs.open(file, "r+");
  const { size } = await handle.stat();
  await handle.write(Buffer.from([0xff]), 0, 1, size - 1);
}
it("returns the still-owed comparison only for opted-in hard-link-only publication", async () => {
  seed();
  const receipt = await fixture.snapshot({ deferPublishedContentCheck: true });
  expect(receipt).toMatchObject(snapshotContent(await fs.readFile(fixture.targetPath)));
  expect(receipt.deferredContentCheck).toBeDefined();
  if (!receipt.deferredContentCheck) {
    throw new Error("missing deferred comparison");
  }
  await assertDeferredSqliteContent(fixture.targetPath, {
    identity: receipt.deferredContentCheck.identity,
    content: receipt,
  });
  await corrupt(fixture.targetPath);
  await expect(
    assertDeferredSqliteContent(fixture.targetPath, {
      identity: receipt.deferredContentCheck.identity,
      content: receipt,
    }),
  ).rejects.toThrow("SQLite snapshot hash mismatch");
});
it.each(["opt-out", "after-publish", "copied-staging"] as const)(
  "keeps the comparison for %s",
  async (mode) => {
    seed();
    if (mode === "copied-staging") {
      state.transfer = exclusiveCopyPublication();
    }
    const receipt = await fixture.snapshot({
      deferPublishedContentCheck: mode !== "opt-out",
      ...(mode === "after-publish"
        ? {
            afterPublish: (guard) => {
              guard.assertTargetUnchanged();
            },
          }
        : {}),
    });
    expect(receipt.deferredContentCheck).toBeUndefined();
  },
);
it("refuses changed bytes from target copy fallback instead of deferring them", async () => {
  seed();
  state.finalTransfer = exclusiveCopyPublication(corrupt);
  await expect(fixture.snapshot({ deferPublishedContentCheck: true })).rejects.toThrow(
    "SQLite snapshot hash mismatch",
  );
  await expect(fs.stat(fixture.targetPath)).rejects.toMatchObject({ code: "ENOENT" });
});
