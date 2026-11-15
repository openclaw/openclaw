import "../test-utils/prepare-compiled-subprocesses.js";
import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { migrateLegacyConfig } from "../commands/doctor/shared/legacy-config-migrate.js";
import { createSuiteTempRootTracker } from "../test-helpers/temp-dir.js";
import { createConfigIO } from "./io.factory.js";

const roots = createSuiteTempRootTracker({ prefix: "openclaw-skill-library-split-" });
beforeAll(() => roots.setup());
afterEach(async () => {
  const { closeOpenClawStateDatabaseForTest } = await import("../state/openclaw-state-db.js");
  closeOpenClawStateDatabaseForTest();
});
afterAll(() => roots.cleanup());

it("a fresh config write records the split without repair, and later post-split policy survives Doctor", async () => {
  const home = await roots.make();
  const configPath = path.join(home, "openclaw.json");
  const env = { HOME: home, OPENCLAW_STATE_DIR: home, OPENCLAW_CONFIG_PATH: configPath };
  const io = createConfigIO({
    env,
    homedir: () => home,
    logger: { warn: vi.fn(), error: vi.fn() },
  });
  const saved = async () => JSON.parse(await fs.readFile(configPath, "utf8"));
  const doctor = (raw: unknown) => migrateLegacyConfig(raw, { sourceConfigBeforeMigrations: raw });

  await io.writeConfigFile({ tools: { allow: ["read", "skill_workshop"] } });
  const fresh = await saved();
  expect(fresh.tools.allow).toEqual(["read", "skill_workshop"]);
  expect(fresh.meta.migrations.skillLibraryToolSplit).toBe(true);

  await io.writeConfigFile({
    ...fresh,
    tools: { allow: ["read", "skill_library"], deny: ["skill_workshop"] },
  });
  const deliberate = await saved();
  for (let run = 0; run < 2; run += 1) {
    expect(doctor(deliberate).changes).toEqual([]);
  }
  expect(deliberate.tools).toEqual({ allow: ["read", "skill_library"], deny: ["skill_workshop"] });

  // The same lists without the marker are pre-split policy, so Doctor extends the deny once.
  const { meta: _meta, ...unmarked } = deliberate;
  const repaired = doctor(unmarked);
  expect(repaired.config?.tools?.deny).toEqual(["skill_workshop", "skill_library"]);
  expect(repaired.config?.meta?.migrations?.skillLibraryToolSplit).toBe(true);
});
