import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildMaturityRendererArgs } from "../../scripts/qa/check-maturity.mts";
import {
  collectAppMaturityInventory,
  collectPluginMaturityInventory,
} from "../../scripts/qa/maturity-inventory.mts";
import { createTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = createTempDirTracker();

afterEach(() => tempDirs.cleanup());

describe("maturity inventory", () => {
  it("forwards maturity check arguments to the renderer", () => {
    expect(buildMaturityRendererArgs(["--evidence-dir", "fixtures/qa", "--strict-inputs"])).toEqual(
      [
        "--import",
        "./scripts/tsx.mjs",
        "scripts/qa/render-maturity-docs.ts",
        "--check",
        "--evidence-dir",
        "fixtures/qa",
        "--strict-inputs",
      ],
    );
  });

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

  it("reports a new official plugin until it has a maturity owner", () => {
    const repoRoot = tempDirs.make("openclaw-maturity-plugin-inventory-");
    const catalogPath = path.join(repoRoot, "scripts/lib/official-external-plugin-catalog.json");
    fs.mkdirSync(path.dirname(catalogPath), { recursive: true });
    fs.writeFileSync(
      catalogPath,
      JSON.stringify({
        entries: [
          { openclaw: { plugin: { id: "brave", label: "Brave Search" } } },
          { openclaw: { plugin: { id: "tokenjuice", label: "Tokenjuice" } } },
          { openclaw: { plugin: { id: "unmapped-tool", label: "Unmapped Tool" } } },
        ],
      }),
    );

    const projection = collectPluginMaturityInventory(repoRoot);

    expect(projection.membersBySurface.get("web-search")?.map((member) => member.id)).toEqual([
      "brave",
    ]);
    expect(projection.membersBySurface.get("tools")?.map((member) => member.id)).toEqual([
      "tokenjuice",
    ]);
    expect(projection.unmapped.map((member) => member.id)).toEqual(["unmapped-tool"]);
  });
});
