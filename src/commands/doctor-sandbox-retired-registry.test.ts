import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { note } from "../../packages/terminal-core/src/note.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  detectLegacySandboxRegistryFileIssues,
  legacySandboxRegistryInspectionToHealthFinding,
  legacySandboxRegistryInspectionToRepairEffect,
  maybeRepairSandboxRegistryFiles,
} from "./doctor-sandbox.js";

const fixture = vi.hoisted(() => ({ root: "" }));
const at = (name: string) => path.join(fixture.root, name);
const read = (file: string) => fs.readFileSync(file, "utf8");
vi.mock("../../packages/terminal-core/src/note.js", () => ({ note: vi.fn() }));
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

const repair = (shouldRepair = true) => maybeRepairSandboxRegistryFiles({ shouldRepair }, () => {});
const expectArchiveNote = (location: string) =>
  expect(note).toHaveBeenLastCalledWith(expect.stringContaining(location), "Sandbox");

it.each([
  { name: "containers.json", sharded: false, bytes: '{"entries":[]}' },
  { name: "browsers.json", sharded: false, bytes: "{malformed original bytes\n" },
  { name: "containers", sharded: true, bytes: '{"containerName":"retained-container"}' },
  { name: "browsers", sharded: true, bytes: '{"containerName":"retained-browser"}' },
  { name: "containers", sharded: true, bytes: "original bytes", occupied: true },
])("archives $name byte-for-byte ($occupied)", async ({ name, sharded, bytes, occupied }) => {
  const source = at(name);
  if (sharded) {
    fs.mkdirSync(source);
  }
  const contentPath = sharded ? path.join(source, "entry.json") : source;
  fs.writeFileSync(contentPath, bytes);
  if (occupied) {
    fs.symlinkSync(at("missing-archive"), `${source}.migrated`);
  }

  await repair(false);
  expect(note).toHaveBeenCalledWith(expect.stringContaining("doctor --fix"), "Sandbox");
  const issues = await detectLegacySandboxRegistryFileIssues();
  expect(issues).toHaveLength(1);
  expect(legacySandboxRegistryInspectionToHealthFinding(issues[0]!)).toMatchObject({
    path: source,
    fixHint: expect.stringContaining("archive retired registry files"),
  });
  expect(legacySandboxRegistryInspectionToRepairEffect(issues[0]!)).toMatchObject({
    action: "archive-retired-sandbox-registry",
    target: source,
  });

  await repair();
  const destination = `${source}.migrated${occupied ? ".2" : ""}`;
  const archive = sharded ? `${destination}/entry.json.migrated` : destination;
  expect(fs.existsSync(source)).toBe(false);
  expect(read(archive)).toBe(bytes);
  expect(await detectLegacySandboxRegistryFileIssues()).toEqual([]);
  expectArchiveNote(archive);
  if (occupied) {
    expect(fs.readlinkSync(`${source}.migrated`)).toBe(at("missing-archive"));
  }
});

it("preserves broken source links when a byte-for-byte backup is impossible", async () => {
  const source = at("containers.json");
  const target = at("missing-original.json");
  fs.symlinkSync(target, source);

  await expect(repair()).rejects.toThrow(/symlink|symbolic|regular|link|ENOENT/i);
  expect(fs.readlinkSync(source)).toBe(target);
});

it("refuses an uninspectable source path instead of treating it as absent", async () => {
  fixture.root = at("not-a-directory");
  fs.writeFileSync(fixture.root, "retained bytes");

  await expect(repair()).rejects.toThrow(/Cannot inspect potentially retired state/);
  expect(read(fixture.root)).toBe("retained bytes");
});

it("leaves current installations alone when retired registry paths are absent", async () => {
  fs.writeFileSync(at("current-state"), "current installation");
  expect(await detectLegacySandboxRegistryFileIssues()).toEqual([]);
  await repair();
  expect(note).not.toHaveBeenCalled();
  expect(fs.readdirSync(fixture.root)).toEqual(["current-state"]);
});
