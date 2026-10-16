import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { note } from "../../packages/terminal-core/src/note.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { RetiredStateFormatError } from "../infra/state-migrations.retired-files.js";
import {
  detectLegacySandboxRegistryFileIssues,
  legacySandboxRegistryInspectionToHealthFinding,
  legacySandboxRegistryInspectionToRepairEffect,
  maybeRepairSandboxRegistryFiles,
} from "./doctor-sandbox.js";

const fixture = vi.hoisted(() => ({ root: "" }));
vi.mock("../../packages/terminal-core/src/note.js", () => ({ note: vi.fn() }));
vi.mock("../agents/sandbox.js", () => ({}));
vi.mock("../agents/sandbox/docker.js", () => ({}));
vi.mock("../agents/sandbox/constants.js", () => ({
  get SANDBOX_REGISTRY_PATH() {
    return path.join(fixture.root, "containers.json");
  },
  get SANDBOX_BROWSER_REGISTRY_PATH() {
    return path.join(fixture.root, "browsers.json");
  },
  get SANDBOX_CONTAINERS_DIR() {
    return path.join(fixture.root, "containers");
  },
  get SANDBOX_BROWSERS_DIR() {
    return path.join(fixture.root, "browsers");
  },
}));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
beforeEach(() => {
  fixture.root = tempDirs.make("openclaw-retired-sandbox-");
  vi.mocked(note).mockClear();
});

describe("retired sandbox registry files", () => {
  it.each([
    { name: "containers.json", sharded: false, bytes: '{"entries":[]}' },
    { name: "browsers.json", sharded: false, bytes: "{malformed original bytes\n" },
    { name: "containers", sharded: true, bytes: '{"containerName":"retained-container"}' },
    { name: "browsers", sharded: true, bytes: '{"containerName":"retained-browser"}' },
  ])(
    "reports and refuses $name without changing source bytes",
    async ({ name, sharded, bytes }) => {
      const source = path.join(fixture.root, name);
      if (sharded) {
        fs.mkdirSync(source);
      }
      const contentPath = sharded ? path.join(source, "entry.json") : source;
      fs.writeFileSync(contentPath, bytes);

      await maybeRepairSandboxRegistryFiles({ shouldRepair: false });
      expect(note).toHaveBeenCalledWith(expect.stringContaining("OpenClaw 2026.9.7"), "Sandbox");
      const issues = await detectLegacySandboxRegistryFileIssues();
      expect(issues).toHaveLength(1);
      const finding = legacySandboxRegistryInspectionToHealthFinding(issues[0]!);
      expect(finding).toMatchObject({
        path: source,
        fixHint: expect.stringContaining("on the original host"),
      });
      expect(legacySandboxRegistryInspectionToRepairEffect(issues[0]!)).toMatchObject({
        action: "requires-intermediate-sandbox-registry-upgrade",
        target: source,
      });

      await expect(maybeRepairSandboxRegistryFiles({ shouldRepair: true })).rejects.toThrow(
        RetiredStateFormatError,
      );
      expect(fs.readFileSync(contentPath, "utf8")).toBe(bytes);
      expect(fs.readdirSync(fixture.root)).toEqual([name]);
    },
  );

  it("preserves broken source links and reports the intermediate upgrade", async () => {
    const source = path.join(fixture.root, "containers.json");
    const target = path.join(fixture.root, "missing-original.json");
    fs.symlinkSync(target, source);

    await expect(maybeRepairSandboxRegistryFiles({ shouldRepair: true })).rejects.toThrow(
      /retired files.*containers\.json.*OpenClaw 2026\.9\.7/,
    );
    expect(fs.readlinkSync(source)).toBe(target);
  });

  it("refuses an uninspectable source path instead of treating it as absent", async () => {
    fixture.root = path.join(fixture.root, "not-a-directory");
    fs.writeFileSync(fixture.root, "retained bytes");

    await expect(maybeRepairSandboxRegistryFiles({ shouldRepair: true })).rejects.toThrow(
      /Cannot inspect potentially retired state/,
    );
    expect(fs.readFileSync(fixture.root, "utf8")).toBe("retained bytes");
  });

  it("leaves current installations alone when retired registry paths are absent", async () => {
    fs.writeFileSync(path.join(fixture.root, "current-state"), "current installation");
    expect(await detectLegacySandboxRegistryFileIssues()).toEqual([]);
    await maybeRepairSandboxRegistryFiles({ shouldRepair: true });
    expect(note).not.toHaveBeenCalled();
    expect(fs.readdirSync(fixture.root)).toEqual(["current-state"]);
  });
});
