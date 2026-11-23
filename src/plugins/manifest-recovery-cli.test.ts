import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { loadPluginManifest } from "./manifest.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
function manifest(recoveryCli: unknown) {
  const root = dirs.make("recovery-manifest-");
  fs.writeFileSync(
    path.join(root, "openclaw.plugin.json"),
    JSON.stringify({
      id: "fixture",
      configSchema: { type: "object" },
      cliCommands: [{ name: "fixture", description: "Fixture", hasSubcommands: true }],
      doctorContract: { recoveryCli },
    }),
  );
  return loadPluginManifest(root);
}

it("retains exact recovery subtrees beneath declared CLI roots and coalesces duplicates", () => {
  expect(
    manifest([
      ["fixture", "doctor"],
      ["fixture", "doctor"],
    ]),
  ).toMatchObject({
    ok: true,
    manifest: { doctorContract: { recoveryCli: [["fixture", "doctor"]] } },
  });
});

it.each([
  true,
  {},
  ["fixture"],
  [[]],
  [["other", "doctor"]],
  [["fixture", "*"]],
  [["fixture", "../doctor"]],
  [["fixture", "doctor inspect"]],
  [["fixture", " inspect"]],
  [["fixture", "--fix"]],
  [["fixture", "$(recovery)"]],
  [["fixture", 1]],
])("rejects malformed or foreign recovery command paths: %j", (declaration) => {
  expect(manifest(declaration)).toMatchObject({
    ok: false,
    error: expect.stringContaining("recoveryCli"),
  });
});
