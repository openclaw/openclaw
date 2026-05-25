import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { detectUiProtocolFreshnessIssues } from "./doctor-ui.js";

const tempRoots: string[] = [];

async function createOpenClawRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-doctor-ui-"));
  tempRoots.push(root);
  await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ name: "openclaw" }));
  await fs.mkdir(path.join(root, "src/gateway/protocol"), { recursive: true });
  await fs.writeFile(path.join(root, "src/gateway/protocol/schema.ts"), "export {};\n");
  return root;
}

async function touch(filePath: string, date: Date): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, "");
  await fs.utimes(filePath, date, date);
}

describe("detectUiProtocolFreshnessIssues", () => {
  afterEach(async () => {
    await Promise.all(
      tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
    );
  });

  it("reports missing Control UI assets when protocol schema exists", async () => {
    const root = await createOpenClawRoot();
    await fs.mkdir(path.join(root, "ui"), { recursive: true });
    await fs.writeFile(path.join(root, "ui/package.json"), "{}");

    await expect(detectUiProtocolFreshnessIssues({ root })).resolves.toEqual([
      {
        kind: "missing-assets",
        uiIndexPath: path.join(root, "dist/control-ui/index.html"),
        canBuild: true,
      },
    ]);
  });

  it("marks missing assets as not locally buildable when UI sources are absent", async () => {
    const root = await createOpenClawRoot();

    await expect(detectUiProtocolFreshnessIssues({ root })).resolves.toEqual([
      expect.objectContaining({
        kind: "missing-assets",
        canBuild: false,
      }),
    ]);
  });

  it("does not report current Control UI assets", async () => {
    const root = await createOpenClawRoot();
    const schemaPath = path.join(root, "src/gateway/protocol/schema.ts");
    const uiIndexPath = path.join(root, "dist/control-ui/index.html");
    await touch(schemaPath, new Date("2026-01-01T00:00:00.000Z"));
    await touch(uiIndexPath, new Date("2026-01-02T00:00:00.000Z"));

    await expect(detectUiProtocolFreshnessIssues({ root })).resolves.toEqual([]);
  });

  it("reports stale assets even when git history is unavailable", async () => {
    const root = await createOpenClawRoot();
    const schemaPath = path.join(root, "src/gateway/protocol/schema.ts");
    const uiIndexPath = path.join(root, "dist/control-ui/index.html");
    await touch(uiIndexPath, new Date("2026-01-01T00:00:00.000Z"));
    await touch(schemaPath, new Date("2026-01-02T00:00:00.000Z"));

    await expect(detectUiProtocolFreshnessIssues({ root })).resolves.toEqual([
      {
        kind: "stale-assets",
        uiIndexPath,
        changesSinceBuild: [],
        canBuild: false,
      },
    ]);
  });
});
