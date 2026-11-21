import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { note } from "../../packages/terminal-core/src/note.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as registry from "./doctor-sandbox.js";

const fixture = vi.hoisted(() => ({ root: "" }));
const at = (name: string) => path.join(fixture.root, name);
vi.mock("../../packages/terminal-core/src/note.js", () => ({ note: vi.fn() }));
vi.mock("../agents/sandbox/docker.js", () => ({}));
// mock-isolation: Retired-registry repairs must address only each test's temporary sandbox paths.
vi.mock("../agents/sandbox/constants.js", () => {
  const prop = (p: string) => ({ enumerable: true, get: () => path.join(fixture.root, p) });
  const paths = {
    SANDBOX_REGISTRY_PATH: prop("containers.json"),
    SANDBOX_BROWSER_REGISTRY_PATH: prop("browsers.json"),
    SANDBOX_CONTAINERS_DIR: prop("containers"),
    SANDBOX_BROWSERS_DIR: prop("browsers"),
  };
  return Object.defineProperties({}, paths);
});

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
beforeEach(() => {
  fixture.root = tempDirs.make("openclaw-retired-sandbox-");
  vi.mocked(note).mockClear();
});

const repair = (shouldRepair = true) =>
  registry.maybeRepairSandboxRegistryFiles({ shouldRepair }, () => {});
const inspect = registry.detectLegacySandboxRegistryFileIssues;

it.each([
  { name: "browsers.json", sharded: false, bytes: "{malformed original bytes\n" },
  { name: "browsers", sharded: true, bytes: '{"containerName":"retained-browser"}' },
  { name: "containers", sharded: true, bytes: "original bytes", occupied: true },
])("archives $name byte-for-byte ($occupied)", async ({ name, sharded, bytes, occupied }) => {
  const source = at(name);
  if (sharded) {
    fs.mkdirSync(source);
  }
  fs.writeFileSync(sharded ? path.join(source, "entry.json") : source, bytes);
  if (occupied) {
    fs.symlinkSync(at("missing-archive"), `${source}.migrated`);
  }

  await repair(false);
  expect(note).toHaveBeenCalledWith(expect.stringContaining("doctor --fix"), "Sandbox");
  const issues = await inspect();
  expect(issues).toHaveLength(1);
  expect([
    registry.legacySandboxRegistryInspectionToHealthFinding(issues[0]!).path,
    registry.legacySandboxRegistryInspectionToRepairEffect(issues[0]!).target,
  ]).toEqual([source, source]);

  await repair();
  const destination = `${source}.migrated${occupied ? ".2" : ""}`;
  const archive = sharded ? `${destination}/entry.json.migrated` : destination;
  expect(fs.existsSync(source)).toBe(false);
  expect(fs.readFileSync(archive, "utf8")).toBe(bytes);
  expect(await inspect()).toEqual([]);
  expect(note).toHaveBeenLastCalledWith(expect.stringContaining(archive), "Sandbox");
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
  expect(fs.readFileSync(fixture.root, "utf8")).toBe("retained bytes");
});

it("leaves current installations alone when retired registry paths are absent", async () => {
  fs.writeFileSync(at("current-state"), "current installation");
  expect(await inspect()).toEqual([]);
  await repair();
  expect(note).not.toHaveBeenCalled();
  expect(fs.readdirSync(fixture.root)).toEqual(["current-state"]);
});
