import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listDirectoryTreeStrict } from "../infra/directory-walk.js";
import { defaultRuntime } from "../runtime.js";
import { useLocalStateOwnerFixture } from "./local-state-owner.fixture.test-support.js";
import { runTemplatesAddCommand } from "./templates-cli.runtime.js";

async function snapshotTree(root: string): Promise<Record<string, string>> {
  const snapshot: Record<string, string> = {};
  for (const entry of (await listDirectoryTreeStrict(root)).map((walkEntry) => walkEntry.dirent)) {
    const filename = path.join(entry.parentPath, entry.name);
    snapshot[path.relative(root, filename)] = entry.isDirectory()
      ? "directory"
      : (await fs.readFile(filename)).toString("base64");
  }
  return snapshot;
}

describe("Template Add CLI state ownership", () => {
  const fixture = useLocalStateOwnerFixture();
  const output: unknown[] = [];
  afterEach(() => vi.restoreAllMocks());
  let root: string;
  let source: string;

  beforeEach(async () => {
    root = path.dirname(process.env.OPENCLAW_STATE_DIR!);
    source = path.join(root, "template.json");
    output.length = 0;
    vi.spyOn(defaultRuntime, "writeJson").mockImplementation((value) => output.push(value));
    await fs.writeFile(source, JSON.stringify({ schemaVersion: 1, agent: { id: "demo" } }));
  });

  it("refuses Add and dry-run while another process owns the Gateway state", async () => {
    await fixture.startOwner();
    const before = await snapshotTree(root);
    for (const dryRun of [false, true]) {
      await expect(runTemplatesAddCommand(source, { dryRun, json: true })).rejects.toThrow(
        /exclusive offline state ownership.*stop the Gateway/s,
      );
      expect(await snapshotTree(root)).toEqual(before);
    }
    expect(output).toEqual([]);
    expect(fixture.transport.request).not.toHaveBeenCalled();
  });
});
