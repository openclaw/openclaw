import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { loadPluginManifest } from "./manifest.js";
const roots = useAutoCleanupTempDirTracker(afterEach);
it("rejects malformed credential ownership without throwing or echoing its value", () => {
  const root = roots.make("manifest-auth-scope-");
  fs.writeFileSync(
    path.join(root, "openclaw.plugin.json"),
    JSON.stringify({
      id: "fixture",
      configSchema: { type: "object" },
      providers: ["fixture"],
      modelCatalog: { providers: { fixture: { authScope: "private-invalid-value", models: [] } } },
    }),
  );
  expect(loadPluginManifest(root)).toMatchObject({
    ok: false,
    error: "invalid plugin manifest modelCatalog ownership metadata",
  });
});
