import { expect, it } from "vitest";
import { writeRuntimeScriptAssets } from "../../scripts/generate-runtime-script-assets.mjs";

it("keeps executable script assets current with their typed source", async () => {
  await expect(writeRuntimeScriptAssets({ check: true })).resolves.toEqual([]);
});
