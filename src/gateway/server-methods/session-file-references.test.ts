import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { createTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { root as openRoot, type OpenResult } from "../../infra/fs-safe.js";
import { isFileReference, type FileReferenceResult } from "../../shared/file-references.js";
import { createLocalFileReferenceLease } from "./session-file-references.js";

const dirs = createTempDirTracker();
const leases = new Set<Awaited<ReturnType<typeof createLocalFileReferenceLease>>>();
const current = () => {};

afterEach(async () => {
  await Promise.all([...leases].map((lease) => lease.dispose()));
  leases.clear();
  vi.restoreAllMocks();
  dirs.cleanup();
});

async function fixture(files: string[], options: { now?: () => number } = {}) {
  const directory = dirs.make("file-reference-provider-");
  for (const name of files) {
    await fs.mkdir(path.dirname(path.join(directory, name)), { recursive: true });
    await fs.writeFile(path.join(directory, name), "synthetic content");
  }
  const root = await openRoot(directory, { symlinks: "reject", hardlinks: "reject" });
  const read = vi.spyOn(root, "read");
  const opened: OpenResult[] = [];
  const contentReadAssertions: (() => void)[] = [];
  const open = root.open.bind(root);
  vi.spyOn(root, "open").mockImplementation(async (...args) => {
    const file = await open(...args);
    const readFromHandle = vi.spyOn(file.handle, "read");
    const readFileFromHandle = vi.spyOn(file.handle, "readFile");
    contentReadAssertions.push(() => {
      expect(readFromHandle).not.toHaveBeenCalled();
      expect(readFileFromHandle).not.toHaveBeenCalled();
    });
    opened.push(file);
    return file;
  });
  const lease = await createLocalFileReferenceLease({
    root,
    accountId: "account-a",
    workspaceId: "workspace-a",
    rootLabel: "Synthetic workspace",
    authorizationRevision: "authority-a",
    resolverRevision: "resolver-a",
    ...options,
  });
  leases.add(lease);
  return {
    directory,
    root,
    lease,
    opened,
    expectNoContentRead() {
      expect(read).not.toHaveBeenCalled();
      for (const assertNoRead of contentReadAssertions) {
        assertNoRead();
      }
    },
  };
}

function matches(result: FileReferenceResult) {
  expect(result.status).toBe("matches");
  if (result.status !== "matches") {
    throw new Error("Expected metadata candidates");
  }
  return result;
}

describe("local file-reference metadata lease", () => {
  it("preserves distinct case/extension objects and ranks exact paths and names before spoken tokens", async () => {
    const f = await fixture(["src/auth.ts", "test/auth.ts", "src/Auth.ts", "src/auth.js"]);
    const exact = matches(await f.lease.search("src/auth.ts", undefined, current));
    expect(exact.candidates.map(({ reference, match }) => [reference.relativePath, match])).toEqual(
      [
        ["src/auth.ts", "path"],
        ["src/Auth.ts", "spoken"],
      ],
    );
    const named = matches(await f.lease.search("auth.ts", undefined, current));
    expect(named.candidates.map(({ reference, match }) => [reference.relativePath, match])).toEqual(
      [
        ["src/auth.ts", "name"],
        ["test/auth.ts", "name"],
        ["src/Auth.ts", "spoken"],
      ],
    );
    expect(new Set(named.candidates.map(({ reference }) => reference.objectId)).size).toBe(3);
    f.expectNoContentRead();
  });

  it("round trips the provider identity and revalidates the actual object without reading content", async () => {
    const f = await fixture(["src/café-שלום.ts"]);
    const result = matches(await f.lease.search("src/café-שלום.ts", undefined, current));
    const reference = result.candidates[0]!.reference;
    const serialized = JSON.stringify(reference);
    const parsed: unknown = JSON.parse(serialized);
    expect(isFileReference(parsed)).toBe(true);
    expect(parsed).toEqual(reference);
    expect(reference).toMatchObject({
      accountId: "account-a",
      workspaceId: "workspace-a",
      relativePath: "src/café-שלום.ts",
      namespace: "openclaw.session-file.v1",
    });
    expect(await f.lease.revalidate(reference.objectId, current)).toEqual({
      status: "validated",
      reference,
    });
    expect(isFileReference({ ...reference, schemaVersion: 2 })).toBe(false);
    f.expectNoContentRead();
  });

  it("makes invalid, hidden, traversal and unsupported-scheme queries indistinguishable", async () => {
    const f = await fixture([".private-present", "public.txt"]);
    for (const query of [
      "../private",
      "/private",
      "C:\\private",
      "file://private",
      "https://private",
      ".private-present",
      ".private-absent",
      "a\u0000b",
      "é".repeat(1025),
    ]) {
      expect(await f.lease.search(query, undefined, current)).toEqual({ status: "denied" });
    }
    expect(
      await f.lease.search("public", undefined, () => {
        throw new Error("private denial");
      }),
    ).toEqual({ status: "denied" });
    f.expectNoContentRead();
  });

  it("does not expose excluded trees, symlink escapes or hardlinked files", async () => {
    const f = await fixture(["public.txt", "node_modules/private.txt", ".hidden/private.txt"]);
    const outside = dirs.make("file-reference-outside-");
    await fs.writeFile(path.join(outside, "private.txt"), "private fixture");
    await fs.symlink(outside, path.join(f.directory, "linked"), "dir");
    await fs.link(
      path.join(outside, "private.txt"),
      path.join(f.directory, "private-hardlink.txt"),
    );
    const result = matches(await f.lease.search("private", undefined, current));
    expect(result.candidates).toEqual([]);
    f.expectNoContentRead();
  });

  it("rejects rename, deletion and replacement between selection and validation", async () => {
    const f = await fixture(["rename.ts", "delete.ts", "replace.ts"]);
    for (const name of ["rename.ts", "delete.ts", "replace.ts"]) {
      const reference = matches(await f.lease.search(name, undefined, current)).candidates[0]!
        .reference;
      if (name === "delete.ts") {
        await fs.unlink(path.join(f.directory, name));
      } else {
        await fs.rename(path.join(f.directory, name), path.join(f.directory, `${name}.old`));
        if (name === "replace.ts") {
          await fs.writeFile(path.join(f.directory, name), "replacement");
        }
      }
      expect(await f.lease.revalidate(reference.objectId, current)).toEqual({ status: "stale" });
    }
    f.expectNoContentRead();
  });

  it("revokes prior candidates on pagination and rejects a foreign cursor", async () => {
    const f = await fixture(Array.from({ length: 21 }, (_, i) => `item-${i}.ts`));
    const first = matches(await f.lease.search("item", undefined, current));
    expect(first.candidates).toHaveLength(20);
    expect(first.nextCursor).toBeTruthy();
    const old = first.candidates[0]!.reference;
    const last = matches(await f.lease.search("item", first.nextCursor, current));
    expect(last.candidates).toHaveLength(1);
    expect(last.nextCursor).toBeUndefined();
    expect(await f.lease.revalidate(old.objectId, current)).toEqual({ status: "denied" });
    expect(await f.lease.search("item", "foreign-cursor", current)).toEqual({ status: "stale" });
    f.expectNoContentRead();
  });

  it("does not call a 10,001-entry index complete and restarts a changed query after continuation", async () => {
    const f = await fixture(Array.from({ length: 10_001 }, (_, i) => `entry-${i}.ts`));
    let firstName = "";
    for await (const item of f.root.entries(".", { order: "filesystem" })) {
      firstName = item.name;
      break;
    }
    const first = matches(await f.lease.search("absent", undefined, current));
    expect(first.indexComplete).toBe(false);
    expect(first.scannedEntries).toBe(10_000);
    expect(first.nextCursor).toBeTruthy();
    const last = matches(await f.lease.search("absent", first.nextCursor, current));
    expect(last.indexComplete).toBe(true);
    expect(last.scannedEntries).toBe(10_001);
    const restarted = matches(await f.lease.search(firstName, undefined, current));
    expect(restarted.scannedEntries).toBe(10_000);
    expect(restarted.indexComplete).toBe(false);
    expect(restarted.candidates.some(({ reference }) => reference.relativePath === firstName)).toBe(
      true,
    );
    f.expectNoContentRead();
  });

  it("expires and refuses reused object identifiers after disposal", async () => {
    let now = 1_000;
    const f = await fixture(["auth.ts"], { now: () => now });
    const reference = matches(await f.lease.search("auth.ts", undefined, current)).candidates[0]!
      .reference;
    now = f.lease.capability.leaseExpiresAt;
    expect(await f.lease.revalidate(reference.objectId, current)).toEqual({ status: "expired" });
    await f.lease.dispose();
    expect(await f.lease.search("auth.ts", undefined, current)).toEqual({ status: "expired" });
    f.expectNoContentRead();
  });

  it("invalidates an in-flight search when another search replaces it", async () => {
    const f = await fixture(["auth.ts"]);
    const entered = createDeferred();
    const release = createDeferred();
    const entries = f.root.entries.bind(f.root);
    vi.spyOn(f.root, "entries").mockImplementationOnce(async function* (...args) {
      entered.resolve();
      await release.promise;
      yield* entries(...args);
    });
    const first = f.lease.search("auth", undefined, current);
    await entered.promise;
    const second = f.lease.search("auth.ts", undefined, current);
    release.resolve();
    expect(await first).toEqual({ status: "stale" });
    expect(matches(await second).candidates[0]?.reference.relativePath).toBe("auth.ts");
    f.expectNoContentRead();
  });

  it("makes repeated disposal wait until the actual pinned descriptor closes", async () => {
    const f = await fixture(["auth.ts"]);
    await f.lease.search("auth.ts", undefined, current);
    const opened = f.opened[0]!;
    const dispose = opened[Symbol.asyncDispose].bind(opened);
    const entered = createDeferred();
    const release = createDeferred();
    vi.spyOn(opened, Symbol.asyncDispose).mockImplementation(async () => {
      entered.resolve();
      await release.promise;
      await dispose();
    });
    let completed = 0;
    const first = f.lease.dispose().then(() => {
      completed += 1;
    });
    await entered.promise;
    const second = f.lease.dispose().then(() => {
      completed += 1;
    });
    await Promise.resolve();
    expect(completed).toBe(0);
    expect(opened.handle.fd).toBeGreaterThanOrEqual(0);
    release.resolve();
    await Promise.all([first, second]);
    expect(completed).toBe(2);
    expect(opened.handle.fd).toBe(-1);
  });
});
