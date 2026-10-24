import fs from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { writeOpenClawConfig } from "../config/test-helpers.js";
import { resolveDoctorHealthContributions } from "../flows/doctor-health-contributions.test-support.js";
import { withEnvAsync } from "../test-utils/env.js";
import { prepareDoctorContext } from "./doctor-config-flow.test-support.js";
import { useDoctorConfigPreflightHome } from "./doctor-config-preflight.test-support.js";

const withHome = useDoctorConfigPreflightHome();

it("does not rediscover settled legacy state after config preflight", () =>
  withHome(async (home) => {
    const bundledRoot = path.join(home, "bundled");
    const pluginRoot = path.join(bundledRoot, "scan-counter");
    const countPath = path.join(home, "detections");
    fs.mkdirSync(pluginRoot, { recursive: true });
    const action = { id: "state", doctorOnly: true };
    fs.writeFileSync(
      path.join(pluginRoot, "package.json"),
      JSON.stringify({ openclaw: { extensions: ["./index.cjs"] } }),
    );
    fs.writeFileSync(
      path.join(pluginRoot, "openclaw.plugin.json"),
      JSON.stringify({
        id: "scan-counter",
        configSchema: {},
        doctorContract: { stateMigrations: [action] },
      }),
    );
    fs.writeFileSync(path.join(pluginRoot, "index.cjs"), "throw new Error('runtime unloaded');\n");
    fs.writeFileSync(
      path.join(pluginRoot, "doctor-contract-api.cjs"),
      `const fs = require("node:fs");
module.exports = { stateMigrations: [{
  ...${JSON.stringify(action)}, label: "Scan counter",
  detectLegacyState: () => { fs.appendFileSync(${JSON.stringify(countPath)}, "scan\\n"); return null; },
  migrateLegacyState: () => { throw new Error("no pending migration"); },
}] };\n`,
    );
    await withEnvAsync(
      {
        OPENCLAW_BUNDLED_PLUGINS_DIR: bundledRoot,
        OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR: "1",
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: undefined,
      },
      async () => {
        const configPath = await writeOpenClawConfig(home, {
          meta: { migrations: { webhookListeners: true } },
          messages: { queue: { allowCollaborativeSteering: false } },
          gateway: { mode: "local" },
          agents: { entries: { main: { workspace: path.join(home, "workspace") } } },
          plugins: { allow: ["scan-counter"] },
        });
        await using ctx = await prepareDoctorContext(configPath);
        expect(ctx.configResult.shouldWriteConfig).toBe(false);
        const scansAfterPreflight = fs.readFileSync(countPath, "utf8");
        expect(scansAfterPreflight).toContain("scan\n");
        const legacyState = resolveDoctorHealthContributions().find(
          (contribution) => contribution.id === "doctor:legacy-state",
        )!;
        await legacyState.run(ctx);
        expect(fs.readFileSync(countPath, "utf8")).toBe(scansAfterPreflight);
        ctx.cfg = { ...ctx.cfg, session: { mainKey: "changed" } };
        await legacyState.run(ctx);
        expect(fs.readFileSync(countPath, "utf8")).toBe(`${scansAfterPreflight}scan\n`);
        ctx.cfg = ctx.configResult.cfg;
        ctx.invalidatePluginMetadataSnapshot?.();
        await legacyState.run(ctx);
        expect(fs.readFileSync(countPath, "utf8")).toBe(`${scansAfterPreflight}scan\nscan\n`);
      },
    );
  }));
