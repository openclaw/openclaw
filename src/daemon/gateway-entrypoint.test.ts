import fs from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { withTempDir } from "../test-utils/temp-dir.js";
import { resolveGatewayInstallEntrypoint } from "./gateway-entrypoint.js";

it("keeps the installed recovery entry order and handles missing older entries", async () => {
  await withTempDir("openclaw-installed-entries-", async (root) => {
    await fs.mkdir(path.join(root, "dist"));
    const names = ["index.js", "index.mjs", "entry.js", "entry.mjs"];
    for (const name of names.toReversed()) {
      await fs.writeFile(path.join(root, "dist", name), "");
    }
    for (const name of names) {
      const entry = path.join(root, "dist", name);
      expect(await resolveGatewayInstallEntrypoint(root)).toBe(entry);
      await fs.unlink(entry);
    }
    expect(await resolveGatewayInstallEntrypoint(root)).toBeUndefined();
    expect(await resolveGatewayInstallEntrypoint(undefined)).toBeUndefined();
  });
});
