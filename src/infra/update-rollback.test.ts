// Update rollback marker tests use only isolated state directories.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  formatUpdateRollbackNarration,
  readUpdateRollbackTransaction,
  resolveUpdateRollbackMarkerPath,
  writeUpdateRollbackTransaction,
} from "./update-rollback.js";

const temporaryRoots: string[] = [];

async function temporaryStateDir(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-update-rollback-"));
  temporaryRoots.push(root);
  return path.join(root, "state");
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true })));
});

describe("update rollback marker", () => {
  it("round-trips an owner-only rolled-back transaction and formats narration", async () => {
    const stateDir = await temporaryStateDir();
    const env = { OPENCLAW_STATE_DIR: stateDir };
    await writeUpdateRollbackTransaction({
      env,
      transaction: {
        state: "rolled_back",
        newVersion: "2.0.0",
        previousVersion: "1.9.0",
        currentRoot: path.join(stateDir, "current"),
        retainedRoot: path.join(stateDir, "previous"),
        gatewayPort: 19001,
        error: "gateway exited with status 23 before readiness",
      },
    });

    const markerPath = resolveUpdateRollbackMarkerPath(env);
    expect((await fs.stat(markerPath)).mode & 0o777).toBe(0o600);
    const transaction = await readUpdateRollbackTransaction(env);
    expect(transaction?.state).toBe("rolled_back");
    expect(formatUpdateRollbackNarration(transaction)).toBe(
      "The update to 2.0.0 broke and was rolled back to 1.9.0; the error was: gateway exited with status 23 before readiness; run `openclaw update` to retry.",
    );
  });

  it("rejects malformed, duplicate, and root-path marker fields", async () => {
    const stateDir = await temporaryStateDir();
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const markerPath = resolveUpdateRollbackMarkerPath(env);
    await fs.mkdir(stateDir, { recursive: true });
    await fs.writeFile(markerPath, "version=1\nstate=pending\n");
    expect(await readUpdateRollbackTransaction(env)).toBeNull();
    await fs.writeFile(
      markerPath,
      "version=1\nversion=1\nstate=pending\nnew_version=2\nprevious_version=1\ncurrent_root=/\nretained_root=/tmp/old\ngateway_port=1\n",
    );
    expect(await readUpdateRollbackTransaction(env)).toBeNull();
  });
});
