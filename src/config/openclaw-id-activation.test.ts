import fs from "node:fs/promises";
import { expect } from "vitest";
import { stateTest } from "../plugin-state/plugin-state-fixtures.test-support.js";
import { writeWizardConfigFile } from "../wizard/setup.shared.js";
import { createConfigIO } from "./io.js";
import { replaceConfigFile } from "./mutate.js";
import type { OpenClawConfig } from "./types.js";

const it = stateTest("openclaw-id-activation");
const id = "openclaw-id-access";
for (const writer of ["replace", "wizard", "io"] as const) {
  it(`${writer} admits only Access in the activation write and preserves it when disabling`, async ({
    state,
  }) => {
    state.applyEnv();
    const plugins = { allow: ["browser"] };
    await state.writeConfig({ plugins });
    const next: OpenClawConfig = { plugins, gateway: { openclawId: { enabled: true } } };
    if (writer === "replace") {
      await replaceConfigFile({ sourceConfig: next });
    } else if (writer === "wizard") {
      await writeWizardConfigFile(next);
    } else {
      await createConfigIO().writeConfigFile(next);
    }
    const saved: OpenClawConfig = JSON.parse(await fs.readFile(state.configPath, "utf8"));
    expect(saved.plugins).toEqual({ allow: ["browser", id] });
    expect(Object.keys(saved.gateway?.roles?.definitions ?? {}).toSorted()).toEqual([
      "admin",
      "guest",
      "operator",
      "viewer",
    ]);
    await replaceConfigFile({
      sourceConfig: { ...saved, gateway: { ...saved.gateway, openclawId: { enabled: false } } },
    });
    expect(JSON.parse(await fs.readFile(state.configPath, "utf8")).plugins).toEqual(saved.plugins);
  });
}
const policies: OpenClawConfig["plugins"][] = [
  undefined,
  { allow: [] },
  { allow: ["browser", id] },
  { allow: ["browser", " OpenClaw-ID-Access "] },
  { allow: ["browser"], deny: [id] },
  { allow: ["browser"], deny: [" OpenClaw-ID-Access "] },
  { allow: ["browser"], entries: { [id]: { enabled: false } } },
  { allow: ["browser"], entries: { "OpenClaw-ID-Access": { enabled: false } } },
  { enabled: false, allow: ["browser"] },
];
for (const plugins of policies) {
  it(`preserves existing plugin policy ${JSON.stringify(plugins)}`, async ({ state }) => {
    state.applyEnv();
    await state.writeConfig({ plugins });
    await replaceConfigFile({
      sourceConfig: { plugins, gateway: { openclawId: { enabled: true } } },
    });
    expect(JSON.parse(await fs.readFile(state.configPath, "utf8")).plugins).toEqual(plugins);
  });
}
it("unrelated writes do not consent to repairing an already-enabled installation", async ({
  state,
}) => {
  state.applyEnv();
  const config: OpenClawConfig = {
    plugins: { allow: ["browser"] },
    gateway: { openclawId: { enabled: true } },
  };
  await state.writeConfig(config);
  await replaceConfigFile({ sourceConfig: { ...config, logging: { level: "warn" } } });
  expect(JSON.parse(await fs.readFile(state.configPath, "utf8")).plugins).toEqual(config.plugins);
});
