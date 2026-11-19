import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { parseRemoteWorkspaceManifestEnvelope } from "./workspace-hash-memo.js";
import type { WorkspaceManifestProgram } from "./workspace-manifest-script-bindings.js";
import { runWorkspaceManifestProgram } from "./workspace-manifest-script.generated.mjs";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it("keeps overlapping captures and their mutation authority bound to each invocation", async () => {
  const root = tempDirs.make("workspace-manifest-callable-");
  const baseCommit = "a".repeat(40);
  const fixture = async (name: string) => {
    const workspace = path.join(root, name);
    const home = path.join(root, `${name}-home`);
    await fs.mkdir(workspace);
    await fs.mkdir(home);
    await fs.writeFile(path.join(workspace, "file.txt"), name);
    let stdout = "";
    const processBinding: Parameters<WorkspaceManifestProgram>[0] = {
      argv: [process.execPath, workspace, baseCommit, "eligible", "memo-v1"],
      env: { HOME: home },
      pid: process.pid,
      platform: process.platform,
      stdout: {
        write: (value) => {
          stdout += value;
        },
      },
    };
    return { workspace, home, processBinding, stdout: () => stdout };
  };
  const first = await fixture("first");
  const second = await fixture("second");
  const entered = Promise.withResolvers<void>();
  const inventory = Promise.withResolvers<Buffer>();
  let firstCurrent = true;
  const pending = runWorkspaceManifestProgram(
    first.processBinding,
    () => "[]",
    () => {
      if (!firstCurrent) {
        throw new Error("first capture retired");
      }
    },
    async () => {
      entered.resolve();
      return await inventory.promise;
    },
    8192,
  );
  try {
    await entered.promise;
    await runWorkspaceManifestProgram(
      second.processBinding,
      () => "[]\n",
      () => {},
      async () => Buffer.from("file.txt\0"),
      8192,
    );
    firstCurrent = false;
    const rejected = expect(pending).rejects.toThrow("first capture retired");
    inventory.resolve(Buffer.from("file.txt\0"));
    await rejected;

    const envelope = parseRemoteWorkspaceManifestEnvelope(second.stdout());
    const raw = await fs.readFile(
      path.join(
        second.home,
        ".openclaw-worker",
        "manifests",
        `${envelope.manifestRef.slice(7)}.json`,
      ),
      "utf8",
    );
    expect(envelope.manifestRef).toBe("sha256:" + createHash("sha256").update(raw).digest("hex"));
    expect(JSON.parse(raw)).toMatchObject({
      baseCommit,
      entries: [
        { path: "file.txt", size: 6, sha256: createHash("sha256").update("second").digest("hex") },
      ],
    });
    expect(first.stdout()).toBe("");
    expect(await fs.readdir(path.join(first.home, ".openclaw-worker", "manifests"))).toEqual([]);
  } finally {
    firstCurrent = false;
    inventory.resolve(Buffer.from("file.txt\0"));
    await pending.catch(() => undefined);
  }
});
