import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { prepareDoctorContext } from "./doctor-config-flow.test-support.js";
import { useDoctorConfigPreflightHome } from "./doctor-config-preflight.test-support.js";

const withHome = useDoctorConfigPreflightHome();
afterEach(() => closeOpenClawStateDatabaseForTest());

it("carries retired selection warnings from the real Doctor plan into the update receipt input", async () => {
  await withHome(async (home) => {
    const configPath = path.join(home, ".openclaw", "openclaw.json");
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    const original = JSON.stringify({
      gateway: { mode: "local" },
      agents: {
        defaults: { model: "anthropic/claude-sonnet-4-6", skills: ["synthetic-current"] },
        entries: { main: { skills: [] } },
      },
      skills: { entries: { "synthetic-disabled": { enabled: false } } },
    });
    await fs.writeFile(configPath, original);
    const ctx = await prepareDoctorContext(configPath);
    const warnings = ctx.configResult.warnings ?? [];
    expect(
      warnings.filter((warning) => warning.includes("prior agent-specific restrictions")),
    ).toHaveLength(2);
    expect(warnings.join("\n")).toContain("All currently and future otherwise-eligible skills");
    expect(warnings.join("\n")).toContain("old [] no longer disables all skills");
    expect(ctx.cfg.agents?.defaults).not.toHaveProperty("skills");
    expect(ctx.cfg.agents?.entries?.main).not.toHaveProperty("skills");
    expect(ctx.cfg.skills?.entries?.["synthetic-disabled"]?.enabled).toBe(false);
    const backups = await fs.readdir(path.dirname(configPath));
    expect(
      await Promise.all(
        backups
          .filter((name) => /^openclaw\.json\.bak(?:\.\d+)?$/u.test(name))
          .map((name) => fs.readFile(path.join(path.dirname(configPath), name), "utf8")),
      ),
    ).toContain(original);
  });
});
