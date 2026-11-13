import fs from "node:fs/promises";
import path from "node:path";
import { sha256File } from "@openclaw/fs-safe/durability";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred, nextEventLoopTurn } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { runSkillsSyncFilesystem } from "./workspace-skill-sync-files.js";

vi.mock("@openclaw/fs-safe/durability", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@openclaw/fs-safe/durability")>()),
  sha256File: vi.fn(),
}));
const temporary = useAutoCleanupTempDirTracker(afterEach);

it("joins the sibling hash before a failed filesystem unit releases native custody", async () => {
  const directory = temporary.make("skills-hash-settlement-");
  const source = path.join(directory, "source.txt");
  const prepared = await runSkillsSyncFilesystem(
    { operation: "prepare", directory: path.join(directory, "target") },
    () => {},
    () => {},
  );
  const destination = path.join(prepared!.target.directory, "copy.txt");
  await fs.writeFile(source, "same");
  await fs.writeFile(destination, "same");
  const failure = new Error("source hash failed");
  const entered = createDeferred();
  const sibling = createDeferred<Awaited<ReturnType<typeof sha256File>>>();
  vi.mocked(sha256File)
    .mockRejectedValueOnce(failure)
    .mockImplementationOnce(() => {
      entered.resolve();
      return sibling.promise;
    });
  let settled = false;
  const operation = runSkillsSyncFilesystem(
    { operation: "copy", target: prepared!.target, source, destination, reconcile: true },
    () => {},
    () => {},
  )
    .catch((error: unknown) => error)
    .finally(() => {
      settled = true;
    });
  try {
    await entered.promise;
    await nextEventLoopTurn();
    expect(settled).toBe(false);
  } finally {
    sibling.resolve({ bytes: 4, digest: "same" });
    expect(await operation).toBe(failure);
  }
});
