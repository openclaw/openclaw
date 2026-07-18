// Doctor rollback narration uses an isolated state directory.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { writeUpdateRollbackTransaction } from "../infra/update-rollback.js";

const note = vi.hoisted(() => vi.fn());
vi.mock("../../packages/terminal-core/src/note.js", () => ({ note }));

const temporaryRoots: string[] = [];

afterEach(async () => {
  note.mockClear();
  await Promise.all(temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true })));
});

describe("Doctor update rollback narration", () => {
  it("mentions the failed and restored versions with retry guidance", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-doctor-rollback-"));
    temporaryRoots.push(root);
    const env = { OPENCLAW_STATE_DIR: path.join(root, "state") };
    await writeUpdateRollbackTransaction({
      env,
      transaction: {
        state: "rolled_back",
        newVersion: "2.0.0",
        previousVersion: "1.9.0",
        currentRoot: path.join(root, "current"),
        retainedRoot: path.join(root, "retained"),
        gatewayPort: 19001,
        error: "gateway exited",
      },
    });
    const { noteUpdateRollbackStatus } = await import("./doctor-update-rollback.js");

    await noteUpdateRollbackStatus(env);

    expect(note).toHaveBeenCalledWith(
      expect.stringContaining("rolled back to 1.9.0"),
      "Update rollback",
    );
    expect(note).toHaveBeenCalledWith(
      expect.stringContaining("openclaw update"),
      "Update rollback",
    );
  });
});
