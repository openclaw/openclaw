import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { collectAppMaturityInventory } from "../../scripts/qa/maturity-inventory.mts";
import { createTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = createTempDirTracker();

afterEach(() => tempDirs.cleanup());

describe("maturity inventory", () => {
  it("reports a new app root until it has a maturity owner", () => {
    const repoRoot = tempDirs.make("openclaw-maturity-app-inventory-");
    for (const name of ["android", "shared", "unmapped-desktop"]) {
      fs.mkdirSync(path.join(repoRoot, "apps", name), { recursive: true });
    }

    const projection = collectAppMaturityInventory(repoRoot);

    expect(projection.membersBySurface.get("android")?.map((member) => member.id)).toEqual([
      "android",
    ]);
    expect(projection.ignored.map((member) => member.id)).toEqual(["shared"]);
    expect(projection.unmapped.map((member) => member.id)).toEqual(["unmapped-desktop"]);
  });
});
