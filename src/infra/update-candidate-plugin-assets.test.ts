import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resolveUpdateCandidatePluginPath } from "./update-candidate-paths.js";
import {
  assertUpdateCandidatePluginAsset,
  captureUpdateCandidatePluginAsset,
  readUpdateCandidatePluginAssets,
  sealUpdateCandidatePluginAssets,
} from "./update-candidate-plugin-assets.js";
import { captureUpdateCandidatePluginCodeLink } from "./update-candidate-plugin-code-links.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());
function fixture() {
  const state = fs.realpathSync(dirs.make("private-plugin-asset-"));
  fs.chmodSync(state, 0o700);
  const plugin = resolveUpdateCandidatePluginPath("/source-state", state, "/external/plugin");
  const target = resolveUpdateCandidatePluginPath(
    "/source-state",
    state,
    "/external/assets/config.txt",
  );
  fs.mkdirSync(plugin, { recursive: true });
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, "private bytes");
  const link = path.join(plugin, "config.txt");
  fs.symlinkSync(target, link);
  const code = captureUpdateCandidatePluginCodeLink(
    link,
    fs.lstatSync(link, { bigint: true }),
    fs.readlinkSync(link),
  );
  const edge = captureUpdateCandidatePluginAsset(code, state);
  return { state, plugin, target, link, code, edge };
}

it("seals only exact verified file edges; a code-link receipt alone grants no asset", async () => {
  const f = fixture();
  const receipt = await sealUpdateCandidatePluginAssets(f.state, [f.edge]);
  expect(readUpdateCandidatePluginAssets(f.state, receipt)).toEqual([f.edge]);
  expect(readUpdateCandidatePluginAssets(f.state)).toEqual([]);
  expect(() => assertUpdateCandidatePluginAsset(f.code)).toThrow("Unverified");
  const empty = await sealUpdateCandidatePluginAssets(f.state, [f.code]);
  expect(readUpdateCandidatePluginAssets(f.state, empty)).toEqual([]);
});

it.each(
  ["link", "target", "content", "hardlink", "parent", "root", "receipt"].filter(
    (kind) => kind !== "root" || process.platform !== "win32",
  ),
)("rejects changed %s after producer sealing", async (kind) => {
  const f = fixture();
  const receipt = await sealUpdateCandidatePluginAssets(f.state, [f.edge]);
  if (kind === "link") {
    fs.renameSync(f.link, f.link + ".old");
    fs.symlinkSync(f.target, f.link);
  }
  if (kind === "target") {
    fs.renameSync(f.target, f.target + ".old");
    fs.writeFileSync(f.target, "private bytes");
  }
  if (kind === "content") {
    fs.writeFileSync(f.target, "changed bytes");
  }
  if (kind === "hardlink") {
    fs.linkSync(f.target, f.target + ".alias");
  }
  if (kind === "parent") {
    fs.renameSync(path.dirname(f.target), path.dirname(f.target) + ".old");
    fs.symlinkSync(path.dirname(f.target) + ".old", path.dirname(f.target));
  }
  if (kind === "root") {
    fs.chmodSync(f.state, 0o755);
  }
  if (kind === "receipt") {
    fs.appendFileSync(path.join(f.state, ".update-plugin-assets.json"), " ");
  }
  expect(() => readUpdateCandidatePluginAssets(f.state, receipt)).toThrow();
});

it.each(["outside", "other-state", "directory"])("never upgrades %s to file authority", (kind) => {
  const f = fixture();
  const alternate =
    kind === "outside"
      ? path.join(fs.realpathSync(dirs.make("outside-asset-")), "config.txt")
      : kind === "directory"
        ? path.join(path.dirname(f.target), "directory")
        : path.join(f.state, "credentials/config.txt");
  fs.mkdirSync(path.dirname(alternate), { recursive: true });
  if (kind === "directory") {
    fs.mkdirSync(alternate);
  } else {
    fs.writeFileSync(alternate, "private bytes");
  }
  fs.unlinkSync(f.link);
  fs.symlinkSync(alternate, f.link);
  const code = captureUpdateCandidatePluginCodeLink(
    f.link,
    fs.lstatSync(f.link, { bigint: true }),
    fs.readlinkSync(f.link),
  );
  expect(captureUpdateCandidatePluginAsset(code, f.state).asset).toBeUndefined();
  expect(() => assertUpdateCandidatePluginAsset({ ...code, asset: f.edge.asset })).toThrow();
});

it("binds state selection independently of the manifest's valid digest", async () => {
  const f = fixture();
  const receipt = await sealUpdateCandidatePluginAssets(f.state, [f.edge]);
  expect(() => readUpdateCandidatePluginAssets(path.dirname(f.state), receipt)).toThrow(
    "wrong state root",
  );
});

it("rejects a same-inode mutation during a pinned descriptor read", () => {
  const f = fixture();
  const original = fs.readSync;
  let changed = false;
  vi.spyOn(fs, "readSync").mockImplementation(((...args: Parameters<typeof fs.readSync>) => {
    const result = Reflect.apply(original, fs, args);
    if (!changed) {
      changed = true;
      fs.writeFileSync(f.target, "changed bytes");
    }
    return result;
  }) as typeof fs.readSync);
  expect(() => assertUpdateCandidatePluginAsset(f.edge)).toThrow("changed");
});
