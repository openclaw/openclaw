// Verifies transcript metadata is persisted atomically so an interrupted
// in-place rewrite cannot leave the live session file truncated.
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withTempDir } from "../test-helpers/temp-dir.js";
import type { TranscriptSessionDescriptor } from "./provider-types.js";
import { TranscriptsStore } from "./store.js";

const baseSession: TranscriptSessionDescriptor = {
  sessionId: "session-atomic",
  source: { providerId: "test" },
  startedAt: "2026-06-17T10:00:00.000Z",
};

describe("TranscriptsStore metadata persistence", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps metadata.json readable when an in-place rewrite is interrupted", async () => {
    await withTempDir({ prefix: "openclaw-transcripts-store-" }, async (root) => {
      const store = new TranscriptsStore(root);
      await store.writeSession(baseSession);

      const metadataPath = path.join(store.sessionDir(baseSession), "metadata.json");

      // Simulate a crash mid-write to the destination: a non-atomic writeFile
      // truncates the live file before failing, an atomic stage+rename never
      // touches it (the temp sibling is written instead).
      const realWriteFile = fs.writeFile.bind(fs);
      type WriteFileArgs = Parameters<typeof fs.writeFile>;
      vi.spyOn(fs, "writeFile").mockImplementation((async (
        file: WriteFileArgs[0],
        data: WriteFileArgs[1],
        options: WriteFileArgs[2],
      ) => {
        if (typeof file === "string" && path.resolve(file) === metadataPath) {
          await realWriteFile(file, "{ truncated", options);
          throw Object.assign(new Error("simulated crash"), { code: "EIO" });
        }
        return realWriteFile(file, data, options);
      }) as typeof fs.writeFile);

      await store.updateStopped(baseSession.sessionId, "2026-06-17T11:00:00.000Z").catch(() => {
        // A surfaced write failure is acceptable; data loss is not.
      });

      vi.restoreAllMocks();

      const session = await store.readSession(baseSession.sessionId);
      expect(
        session,
        "metadata.json must remain readable after an interrupted rewrite",
      ).toBeDefined();
      expect(session?.sessionId).toBe(baseSession.sessionId);
    });
  });

  it("preserves tightened file and directory modes across an atomic rewrite", async () => {
    await withTempDir({ prefix: "openclaw-transcripts-store-modes-" }, async (root) => {
      const store = new TranscriptsStore(root);
      await store.writeSession(baseSession);

      const dir = store.sessionDir(baseSession);
      const metadataPath = path.join(dir, "metadata.json");
      await fs.chmod(metadataPath, 0o600);
      await fs.chmod(dir, 0o700);

      await store.updateStopped(baseSession.sessionId, "2026-06-17T11:00:00.000Z");

      // The atomic rewrite must not broaden user-tightened permissions.
      expect((await fs.stat(metadataPath)).mode & 0o777).toBe(0o600);
      expect((await fs.stat(dir)).mode & 0o777).toBe(0o700);
      // ...and the rewrite still landed.
      const reread = await store.readSession(baseSession.sessionId);
      expect(reread?.sessionId).toBe(baseSession.sessionId);
    });
  });
});
