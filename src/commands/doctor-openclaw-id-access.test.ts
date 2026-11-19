import fs from "node:fs/promises";
import { expect } from "vitest";
import { readConfigFileSnapshot } from "../config/io.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  createDoctorHealthFlowContext,
  createDoctorPrompterFixture,
} from "../flows/doctor-health-context.test-support.js";
import { runWriteConfigHealth } from "../flows/doctor-health-contribution-runners.config.js";
import { resolveInitialDoctorHealthContributions } from "../flows/doctor-health-contributions-initial.js";
import { stateTest } from "../plugin-state/plugin-state-fixtures.test-support.js";

const it = stateTest("doctor-openclaw-id-access");
const cfg = (): OpenClawConfig => ({ gateway: { openclawId: { enabled: true } } });

function contribution() {
  const noop = async () => {};
  const result = resolveInitialDoctorHealthContributions({
    runStructuredHealthRepairs: noop,
    runGatewayConfigHealth: noop,
    runAuthProfileMigration: noop,
    runAuthProfileHealth: noop,
    runGatewayAuthHealth: noop,
    runLegacyStateHealth: noop,
  }).find(({ id }) => id === "doctor:openclaw-id-access");
  expect(result, "Access diagnostic is registered in Doctor").toBeDefined();
  return result!;
}

for (const accepted of [false, true]) {
  it(`repairs only Access allowlist membership after consent=${accepted}`, async ({ state }) => {
    state.applyEnv();
    const config = { ...cfg(), plugins: { allow: ["browser"] } };
    await state.writeConfig(config);
    const original = `// preserve on decline\n${await fs.readFile(state.configPath, "utf8")}`;
    await fs.writeFile(state.configPath, original);
    const snapshot = await readConfigFileSnapshot({ observe: false });
    const ctx = createDoctorHealthFlowContext({
      cfg: config,
      env: state.env,
      configPath: state.configPath,
      prompter: createDoctorPrompterFixture(accepted),
      configResult: { confirmedConfigSource: { path: snapshot.path, hash: snapshot.hash! } },
    });
    const check = contribution();
    const access = check.healthChecks.find(({ id }) => id === "core/doctor/openclaw-id-access");
    expect(access, "Access diagnostic is registered in Doctor").toBeDefined();
    expect(await access!.detect({ mode: "doctor", cfg: config, runtime: ctx.runtime })).toEqual([
      expect.objectContaining({
        requirement: "allowlist",
        message: expect.stringContaining("Access page stays off"),
      }),
    ]);
    await check.run(ctx);
    expect(ctx.prompter.confirmAutoFix).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringMatching(/openclaw-id-access.*plugins.allow.*JSON.*comments/),
        initialValue: false,
      }),
    );
    if (!accepted) {
      expect(ctx.cfg).toBe(config);
      expect(await fs.readFile(state.configPath, "utf8")).toBe(original);
    } else {
      expect(await runWriteConfigHealth(ctx, { runPostWriteRepairs: false })).toBe(true);
      const saved = JSON.parse(await fs.readFile(state.configPath, "utf8"));
      expect(saved.plugins).toEqual({ allow: ["browser", "openclaw-id-access"] });
      expect(saved.gateway).toEqual(config.gateway);
    }
  });
}

for (const policy of [
  { deny: ["openclaw-id-access"] },
  { entries: { "openclaw-id-access": { enabled: false } } },
  { enabled: false },
]) {
  it(`Doctor never overrides explicit Access policy ${JSON.stringify(policy)}`, async ({
    state,
  }) => {
    state.applyEnv();
    const config = { ...cfg(), plugins: { allow: ["browser"], ...policy } };
    const ctx = createDoctorHealthFlowContext({
      cfg: config,
      env: state.env,
      prompter: createDoctorPrompterFixture(true),
    });
    await contribution().run(ctx);
    expect(ctx.prompter.confirmAutoFix).not.toHaveBeenCalled();
    expect(ctx.cfg).toBe(config);
    expect(ctx.configResult.pendingChangePanels).toBeUndefined();
  });
}
