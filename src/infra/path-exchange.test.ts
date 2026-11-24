import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { exchangePaths } from "./path-exchange.js";
import { expectedPathExchangeRoute } from "./path-exchange.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  vi.restoreAllMocks();
});

const identity = (target: string) => {
  const stat = fs.lstatSync(target, { bigint: true });
  return `${stat.dev}:${stat.ino}`;
};

/** A package directory and, in another directory, a link that names it once exchanged. */
function directoryAndLink(root: string) {
  const directory = path.join(root, "package");
  const link = path.join(root, "releases", "link");
  fs.mkdirSync(directory);
  fs.writeFileSync(path.join(directory, "marker"), "live");
  fs.mkdirSync(path.dirname(link));
  fs.symlinkSync("releases/link", link);
  return { directory, link };
}

describe("path exchange", () => {
  it.runIf(expectedPathExchangeRoute)(
    "exchanges a directory and a link without replacing either",
    async () => {
      // Spaces and non-ASCII names reach the system call unchanged.
      const { directory, link } = directoryAndLink(tempDirs.make("openclaw-path-exchange ünï 包-"));
      const before = { directory: identity(directory), link: identity(link) };

      const result = await exchangePaths(directory, link);

      expect(result).toEqual({ status: "exchanged", route: expectedPathExchangeRoute });
      expect({ directory: identity(link), link: identity(directory) }).toEqual(before);
      // The link now sits on the first path and names the directory's new place.
      expect(fs.readlinkSync(directory)).toBe("releases/link");
      expect(fs.readFileSync(path.join(directory, "marker"), "utf8")).toBe("live");
    },
  );

  it.runIf(expectedPathExchangeRoute)(
    "reports a refused exchange as unavailable and changes nothing",
    async () => {
      const root = tempDirs.make("openclaw-path-exchange-");
      const parent = path.join(root, "parent");
      const descendant = path.join(parent, "descendant");
      fs.mkdirSync(descendant, { recursive: true });
      const before = [identity(parent), identity(descendant)];

      // No kernel exchanges a directory with its own descendant.
      const result = await exchangePaths(parent, descendant);

      expect(result).toEqual({
        status: "unavailable",
        reason: expect.stringContaining(`${expectedPathExchangeRoute}: `),
      });
      expect([identity(parent), identity(descendant)]).toEqual(before);
    },
  );

  it.runIf(expectedPathExchangeRoute)(
    "throws when another writer replaced a path while the exchange ran",
    async () => {
      const { directory, link } = directoryAndLink(tempDirs.make("openclaw-path-exchange-"));
      const packageIdentity = identity(directory);
      const lstat = fsp.lstat.bind(fsp);
      let reads = 0;
      // Two reads record the paths; the third is the first look after the tool ran.
      // Another writer gets in just before it and replaces the link's old path.
      vi.spyOn(fsp, "lstat").mockImplementation((async (target, options) => {
        reads += 1;
        if (reads === 3) {
          fs.renameSync(link, path.join(path.dirname(link), "moved-by-another-writer"));
          fs.mkdirSync(link);
        }
        return await lstat(target, options as never);
      }) as typeof fsp.lstat);

      await expect(exchangePaths(directory, link)).rejects.toThrow(/another writer/u);
      // The package was moved, not lost.
      expect(identity(path.join(path.dirname(link), "moved-by-another-writer"))).toBe(
        packageIdentity,
      );
    },
  );

  it("reports a missing path as unavailable and leaves the other in place", async () => {
    const root = tempDirs.make("openclaw-path-exchange-");
    const directory = path.join(root, "package");
    fs.mkdirSync(directory);
    const before = identity(directory);

    const result = await exchangePaths(directory, path.join(root, "absent"));

    expect(result).toEqual({ status: "unavailable", reason: expect.stringContaining("ENOENT") });
    expect(identity(directory)).toBe(before);
    expect(fs.readdirSync(root)).toEqual(["package"]);
  });
});
