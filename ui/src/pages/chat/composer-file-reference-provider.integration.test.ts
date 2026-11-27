import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, assert, describe, expect, it, vi } from "vitest";
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

async function flow(directory: string, transcript = utterance, withLiteralComma = false) {
  await fs.mkdir(path.join(directory, "src"));
  for (const name of withLiteralComma ? ["src/auth.ts", "src/auth.ts,"] : ["src/auth.ts"]) {
    await fs.writeFile(path.join(directory, name), "synthetic private contents");
  }
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
  assert.isDefined(complete, "Enabled reference capture must be admitted");
  fixture.externalEdit(transcript);
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
      text: transcript,
      from: 0,
      to: transcript.length,
      previousValue: "",
      value: transcript,
      complete: true,
    },
    true,
  );
  await settled;
  expect(owner.phase).toBe("choosing");
  const first = owner.candidates[0];
  assert.isDefined(first, "Expected a selectable file in the chooser");
  return {
    first,
    fixture,
    owner,
    requests,
    assertNoContentReads() {
      expect(rootRead).not.toHaveBeenCalled();
      expect(handleRead).not.toHaveBeenCalled();
      expect(handleReadFile).not.toHaveBeenCalled();
    },
    async [Symbol.asyncDispose]() {
      owner.dispose();
      await lease?.dispose();
    },
  };
}

describe("actual metadata provider to identity-capable composer", () => {
  it.each(["src/auth.ts", "src/auth.ts,"])("replays dictation and binds %s", async (bestPath) => {
    await withTempDir("m09-provider-editor-", async (directory) => {
      const transcript =
        "Let's inspect Reference File src/auth.ts, end reference, because it's failing.";
      const literalComma = bestPath.endsWith(",");
      await using current = await flow(directory, transcript, literalComma);
      const { owner, fixture } = current;
      const { match, reference: selected } = current.first;
      expect(match).toBe(literalComma ? "path" : "spoken");
      expect(owner.candidates.map((c) => c.reference.relativePath)).toEqual(
        literalComma ? ["src/auth.ts,", "src/auth.ts"] : ["src/auth.ts"],
      );
      expect(selected.namespace).toBe("openclaw.session-file.v1");
      expect(selected.objectId).not.toBe(selected.relativePath);
      owner.select(selected.objectId);
      expect(fixture.destination.snapshot()).toMatchObject({ text: transcript, references: [] });
      await Promise.all([owner.confirm(), owner.confirm()]);
      expect(owner.phase).toBe("committed");
      const confirmed = "Let's inspect @" + bestPath + ", because it's failing.";
      const snapshot = fixture.destination.snapshot();
      const binding = { start: 14, end: 15 + bestPath.length, reference: selected };
      expect(snapshot).toMatchObject({ text: confirmed, references: [binding] });
      expect(current.requests.filter((action) => action === "revalidate")).toHaveLength(1);
      await owner.confirm();
      expect(fixture.destination.snapshot()).toEqual(snapshot);
      const serialized = JSON.stringify({ text: fixture.text, references: snapshot.references });
      const restored: { text: string; references: unknown } = JSON.parse(serialized);
      const references = readComposerFileReferences(restored.text, restored.references);
      expect(references).toEqual(snapshot.references);
      fixture.externalEdit(restored.text, references);
      fixture.remount();
      owner.enable(false);
      expect(fixture.destination.snapshot().references).toEqual([binding]);
      expect(fixture.text).toBe(confirmed);
      current.assertNoContentReads();
    });
  });

  it.each(["rename", "replace", "delete"])(
    "rejects an actual %s before commit without changing the draft",
    async (change) => {
      await withTempDir("m09-provider-stale-", async (directory) => {
        await using current = await flow(directory);
        current.owner.select(current.first.reference.objectId);
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
      });
    },
  );
});
