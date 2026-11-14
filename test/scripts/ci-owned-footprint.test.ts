import {
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { collectCiOwnedFootprint } from "../../scripts/lib/ci-owned-footprint.mts";

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of roots.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});
function root() {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "ci-footprint-")));
  roots.push(directory);
  return directory;
}

it("counts hardlinks once across owned roots without traversing symlinks or reporting paths", async () => {
  const directory = root();
  const left = join(directory, "left");
  const right = join(directory, "right");
  const external = join(directory, "external-private-name");
  for (const path of [left, right, external]) {
    mkdirSync(path);
  }
  const file = join(left, "one");
  writeFileSync(file, Buffer.alloc(8192));
  linkSync(file, join(right, "two"));
  writeFileSync(join(external, "private-payload"), Buffer.alloc(16384));
  symlinkSync(external, join(left, "outside"), process.platform === "win32" ? "junction" : "dir");
  const result = await collectCiOwnedFootprint({ left, right, linkedRoot: join(left, "outside") });
  const [a, b, c] = result.measurements;
  expect(a).toMatchObject({ entries: 3, symlinks: 1, multiplyLinkedFiles: 1, incomplete: false });
  expect(b).toMatchObject({ entries: 2, multiplyLinkedFiles: 1, incomplete: false });
  expect(c).toMatchObject({ entries: 0, incomplete: true });
  expect(BigInt(b!.firstSeenInodeBlockBytes)).toBe(
    lstatSync(right, { bigint: true }).blocks * 512n,
  );
  expect(BigInt(b!.inodeBlockBytes) - BigInt(b!.firstSeenInodeBlockBytes)).toBe(
    lstatSync(file, { bigint: true }).blocks * 512n,
  );
  expect(JSON.stringify(result)).not.toContain(directory);
  expect(JSON.stringify(result)).not.toContain("private");
  expect(result.exclusiveExtentOwnershipMeasured).toBe(false);
});

it("marks missing, budget-exhausted and interrupted roots incomplete without failing the caller", async () => {
  const directory = root();
  const missing = await collectCiOwnedFootprint({ missing: join(directory, "absent") });
  expect(missing.measurements[0]).toMatchObject({ errors: 1, incomplete: true });
  vi.spyOn(performance, "now").mockReturnValueOnce(0).mockReturnValue(1001);
  const exhausted = await collectCiOwnedFootprint({ owned: directory });
  expect(exhausted).toMatchObject({ examined: 0, maxMs: 1000, maxEntries: 250000 });
  expect(exhausted.measurements[0]).toMatchObject({ entries: 0, incomplete: true });
  vi.restoreAllMocks();
  const stopped = await collectCiOwnedFootprint({ owned: directory }, () => true);
  expect(stopped.measurements[0]).toMatchObject({ entries: 0, incomplete: true });
});
