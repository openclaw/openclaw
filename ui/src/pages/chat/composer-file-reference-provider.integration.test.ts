import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLocalFileReferenceLease } from "../../../../src/gateway/server-methods/session-file-references.ts";
import { root as openRoot } from "../../../../src/infra/fs-safe.ts";
import type { SessionsFilesReferencesParams } from "../../../../src/shared/file-references.ts";
import { withTempDir } from "../../../../src/test-utils/temp-dir.ts";
import { readComposerFileReferences } from "../../lib/chat/file-references.ts";
import { createFileReferenceDestinationFixture } from "./composer-file-reference-destination.test-support.ts";
import { ComposerFileReferenceOwner } from "./composer-file-references.ts";

const utterance = "Look at reference file src slash auth dot ts end reference please.";
const fixtureDisposals: (() => void)[] = [];
afterEach(() => {
  for (const dispose of fixtureDisposals.splice(0).toReversed()) {
    dispose();
  }
  vi.restoreAllMocks();
});

async function flow(directory: string) {
  await fs.mkdir(path.join(directory, "src"));
  await fs.writeFile(path.join(directory, "src/auth.ts"), "synthetic private contents");
  const fsRoot = await openRoot(directory, { symlinks: "reject", hardlinks: "reject" });
  const handle = await fs.open(path.join(directory, "src/auth.ts"));
  const handleRead = vi.spyOn(Object.getPrototypeOf(handle), "read");
  const handleReadFile = vi.spyOn(Object.getPrototypeOf(handle), "readFile");
  await handle.close();
  const rootRead = vi.spyOn(fsRoot, "read");
  const fixture = createFileReferenceDestinationFixture();
  fixtureDisposals.push(() => fixture.dispose());
  let revision = 0;
  let lease: Awaited<ReturnType<typeof createLocalFileReferenceLease>> | undefined;
  const requests: string[] = [];
  const client = {};
  // The transport/admission is synthetic; search/revalidation and EditorView are production.
  const request = async (params: SessionsFilesReferencesParams) => {
    requests.push(params.action);
    if (params.action === "capabilities") {
      lease = await createLocalFileReferenceLease({
        root: fsRoot,
        accountId: "synthetic-account",
        workspaceId: "synthetic-workspace",
        rootLabel: "Synthetic workspace",
        authorizationRevision: "revision-1",
        resolverRevision: "resolver-1",
      });
      return { status: "ready", capability: lease.capability };
    }
    if (!lease || params.leaseId !== lease.capability.leaseId) {
      return { status: "denied" };
    }
    if (params.action === "release") {
      await lease.dispose();
      return { status: "released" };
    }
    return params.action === "search"
      ? lease.search(params.query, params.cursor, () => {})
      : lease.revalidate(params.objectId, () => {});
  };
  const owner = new ComposerFileReferenceOwner(() => ({
    client,
    connected: true,
    sessionKey: "agent:main:synthetic-reference",
    agentId: "main",
    draft: fixture.text,
    revision,
    target: fixture.input,
    locale: "en-US",
    eligible: true,
    request,
  }));
  fixtureDisposals.push(() => owner.dispose());
  fixture.onEdit(() => {
    revision += 1;
    owner.sync();
  });
  owner.enable(true);
  const complete = owner.capture();
  if (!complete) {
    throw new Error("Enabled reference capture must be admitted");
  }
  fixture.externalEdit(utterance);
  // Await the real search owner's settlement instead of a one-second polling
  // allowance, which races filesystem work on a loaded host.
  const settled = new Promise<void>((resolve) => {
    const unsubscribe = owner.subscribe(() => {
      if (!owner.busy) {
        unsubscribe();
        resolve();
      }
    });
    fixtureDisposals.push(unsubscribe);
  });
  complete(
    {
      target: fixture.input,
      text: utterance,
      from: 0,
      to: utterance.length,
      previousValue: "",
      value: utterance,
      complete: true,
    },
    true,
  );
  await settled;
  expect(owner.phase).toBe("choosing");
  return {
    fixture,
    owner,
    requests,
    assertNoContentReads() {
      expect(rootRead).not.toHaveBeenCalled();
      expect(handleRead).not.toHaveBeenCalled();
      expect(handleReadFile).not.toHaveBeenCalled();
    },
    async dispose() {
      owner.dispose();
      await lease?.dispose();
    },
  };
}

describe("actual metadata provider to identity-capable composer", () => {
  it("binds the exact object once and retains it through serialization, remount and disablement", async () => {
    await withTempDir("m09-provider-editor-", async (directory) => {
      const current = await flow(directory);
      try {
        const selected = current.owner.candidates[0].reference;
        expect(selected.relativePath).toBe("src/auth.ts");
        expect(selected.namespace).toBe("openclaw.session-file.v1");
        expect(selected.objectId).not.toBe(selected.relativePath);
        current.owner.select(selected.objectId);
        expect(current.fixture.text).toBe(utterance);
        await Promise.all([current.owner.confirm(), current.owner.confirm()]);
        expect(current.owner.phase).toBe("committed");
        expect(current.fixture.text).toBe("Look at @src/auth.ts please.");
        const snapshot = current.fixture.destination.snapshot();
        expect(snapshot.references).toEqual([{ start: 8, end: 20, reference: selected }]);
        expect(current.requests.filter((action) => action === "revalidate")).toHaveLength(1);
        await current.owner.confirm();
        expect(current.fixture.destination.snapshot()).toEqual(snapshot);
        const serialized = JSON.stringify({
          text: current.fixture.text,
          references: snapshot.references,
        });
        const restored: { text: string; references: unknown } = JSON.parse(serialized);
        const references = readComposerFileReferences(restored.text, restored.references);
        expect(references).toEqual(snapshot.references);
        current.fixture.externalEdit(restored.text, references);
        current.fixture.remount();
        current.owner.enable(false);
        expect(current.fixture.destination.snapshot().references[0].reference).toEqual(selected);
        expect(current.fixture.text).toBe("Look at @src/auth.ts please.");
        current.assertNoContentReads();
      } finally {
        await current.dispose();
      }
    });
  });

  it.each(["rename", "replace", "delete"])(
    "rejects an actual %s before commit without changing the draft",
    async (change) => {
      await withTempDir("m09-provider-stale-", async (directory) => {
        const current = await flow(directory);
        try {
          current.owner.select(current.owner.candidates[0].reference.objectId);
          const filename = path.join(directory, "src/auth.ts");
          if (change === "rename") {
            await fs.rename(filename, path.join(directory, "src/renamed.ts"));
          } else {
            await fs.unlink(filename);
            if (change === "replace") {
              await fs.writeFile(filename, "replacement object");
            }
          }
          await current.owner.confirm();
          expect(current.owner.phase).toBe("stale");
          expect(current.fixture.text).toBe(utterance);
          expect(current.fixture.destination.snapshot().references).toEqual([]);
          current.assertNoContentReads();
        } finally {
          await current.dispose();
        }
      });
    },
  );
});
