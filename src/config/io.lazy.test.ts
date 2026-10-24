import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";

vi.mock("../commands/doctor/shared/legacy-config-migrations.js", () => {
  throw new Error("valid config reads must not load Doctor migration implementations");
});

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it("reads a valid config without loading Doctor migrations", async () => {
  const { createConfigIO } = await import("./io.factory.js");
  const root = tempDirs.make("openclaw-config-lazy-");
  const configPath = path.join(root, "openclaw.json");
  const raw = '{"gateway":{"mode":"local"}}';
  fs.writeFileSync(configPath, raw);
  const snapshot = await createConfigIO({
    configPath,
    homedir: () => root,
    observe: false,
    pluginValidation: "core-only",
    env: {
      HOME: root,
      USERPROFILE: root,
      OPENCLAW_CONFIG_PATH: configPath,
      OPENCLAW_STATE_DIR: path.join(root, "state"),
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
      VITEST: "true",
    },
  }).readConfigFileSnapshot();

  expect(snapshot).toMatchObject({
    valid: true,
    config: { gateway: { mode: "local" } },
    legacyIssues: [],
    raw,
  });
  expect(fs.readFileSync(configPath, "utf8")).toBe(raw);
});
