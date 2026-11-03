import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { readConfigFileSnapshot } from "../config/config.js";
import { writeOpenClawConfig } from "../config/test-helpers.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginEntryConfig } from "../config/types.plugins.js";
import {
  runInitialConfigWriteHealth,
  runWriteConfigHealth,
} from "../flows/doctor-health-contribution-runners.config.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { setTestEnvValue, withEnvAsync } from "../test-utils/env.js";
import { prepareDoctorContext } from "./doctor-config-flow.test-support.js";
import { useDoctorConfigPreflightHome } from "./doctor-config-preflight.test-support.js";
import { createDoctorPrompter } from "./doctor-prompter.js";

const readText = (file: string) => fs.readFile(file, "utf8");
async function expectBytes(file: string, expected: string) {
  await expect(fs.readFile(file, "utf8")).resolves.toBe(expected);
}
const writeBackup = (file: string, cfg: OpenClawConfig | string, suffix = "") =>
  fs.writeFile(`${file}.bak${suffix}`, typeof cfg === "string" ? cfg : JSON.stringify(cfg));
function repairConfirmation(effect: () => Promise<boolean>) {
  return vi.fn(async ({ message }: { message: string }) => {
    expect(message).toBe("Apply recommended config repairs now?");
    return effect();
  });
}

const note = vi.hoisted(() => vi.fn<(message: string, title?: string) => void>());
vi.mock("../../packages/terminal-core/src/note.js", () => ({ note }));
const withDoctorConfigPreflightHome = useDoctorConfigPreflightHome();
afterEach(() => {
  note.mockClear();
  closeOpenClawStateDatabaseForTest();
  vi.restoreAllMocks();
});

function expectNote(text: string) {
  expect(note.mock.calls.some(([message]) => message.includes(text))).toBe(true);
}
function warningMessages(fragment = "") {
  return note.mock.calls
    .filter(([message, title]) => title === "Doctor warnings" && message.includes(fragment))
    .map(([message]) => message);
}

function fixture(owner?: string, store?: string): OpenClawConfig {
  return {
    agents: {
      ownership: "explicit",
      entries: { ops: {}, research: {} },
      defaults: {
        model: "anthropic/claude-sonnet-4-6",
        systemAgent: { agentId: "ops" },
        authInheritance: { agentId: "ops" },
        ...(owner === undefined ? {} : { sessionStore: { agentId: owner } }),
      },
    },
    ...(store === undefined ? {} : { session: { store } }),
    gateway: { mode: "local" },
    plugins: { enabled: false },
  };
}

function recoveryPrompter(confirm: () => Promise<boolean>) {
  const prompter = createDoctorPrompter({
    runtime: { error: vi.fn(), exit: vi.fn(), log: vi.fn() },
    options: { repair: true, nonInteractive: true },
  });
  return { ...prompter, confirmRuntimeRepair: vi.fn(confirm) };
}

it.each(["accepted", "declined", "noninteractive update"] as const)(
  "recovers the backed-up owner only with current consent: %s",
  (scenario) =>
    withDoctorConfigPreflightHome(async (home) => {
      const configPath = await writeOpenClawConfig(home, fixture());
      const original = await readText(configPath);
      const reviewingHistory = scenario === "accepted" || scenario === "declined";
      await writeBackup(configPath, reviewingHistory ? original : fixture("ops"));
      if (reviewingHistory) {
        await writeBackup(configPath, fixture("ops"), ".1");
        await writeBackup(configPath, fixture("research"), ".2");
      }
      const prompter = recoveryPrompter(async () => scenario !== "declined");
      await withEnvAsync(
        { OPENCLAW_UPDATE_IN_PROGRESS: scenario === "noninteractive update" ? "1" : undefined },
        async () => {
          await using ctx = await prepareDoctorContext(
            configPath,
            scenario === "noninteractive update"
              ? { options: { repair: true, yes: true, nonInteractive: true } }
              : { prompter },
          );
          if (scenario === "noninteractive update") {
            expect(ctx.cfg.agents?.defaults?.sessionStore?.agentId).toBeUndefined();
            expectNote("removal may have been intentional");
            return;
          }
          expect(prompter.confirmRuntimeRepair).toHaveBeenCalledWith({
            message: expect.stringContaining(`${configPath}.bak.1`),
            initialValue: false,
            requiresInteractiveConfirmation: true,
          });
          await runInitialConfigWriteHealth(ctx);
          const saved = await readConfigFileSnapshot();
          expect(saved.sourceConfig.agents?.defaults?.sessionStore?.agentId).toBe(
            scenario === "accepted" ? "ops" : undefined,
          );
          expect(saved.sourceConfig.agents?.defaults?.authInheritance).toEqual({
            agentId: "ops",
          });
          if (scenario === "accepted") {
            await expectBytes(`${configPath}.bak`, original);
          }
          expectNote(
            scenario === "accepted"
              ? "Restored agents.defaults.sessionStore.agentId"
              : "openclaw config set agents.defaults.sessionStore.agentId ops",
          );
        },
      );
    }),
);

it.each(["store-roundtrip", "retired-agent"])("never invents ownership from %s", (scenario) =>
  withDoctorConfigPreflightHome(async (home) => {
    const configPath = await writeOpenClawConfig(home, fixture());
    const retired = scenario === "retired-agent";
    await writeBackup(
      configPath,
      fixture(
        retired ? "removed" : "ops",
        retired ? undefined : path.join(home, "other-store.json"),
      ),
    );
    if (scenario === "store-roundtrip") {
      await writeBackup(configPath, fixture("research"), ".1");
    }
    const prompter = recoveryPrompter(async () => true);
    await using ctx = await prepareDoctorContext(configPath, { prompter });
    expect(prompter.confirmRuntimeRepair).not.toHaveBeenCalled();
    expect(ctx.cfg.agents?.defaults?.sessionStore?.agentId).toBeUndefined();
    if (scenario === "retired-agent") {
      expectNote("Re-author agents.defaults.sessionStore.agentId");
    }
  }),
);
function createRepairableConfig(home: string) {
  return {
    agents: { entries: { main: { workspace: path.join(home, "workspace") } } },
    // A typo requires a repair proposal; known retired keys normalize automatically.
    browser: { enabled: false, actionTimeoutTypoMs: 5000 },
    gateway: { mode: "local" },
    logging: { level: "info", file: path.join(home, "doctor.log") },
    plugins: { enabled: false },
  };
}

function expectConflictWarning() {
  const warnings = warningMessages().join("\n");
  expect(warnings).toContain("changed");
  expect(warnings).toContain("These config fixes were not written.");
  expect(warnings).toMatch(/rerun "openclaw doctor"/i);
  expect(note.mock.calls.some(([, title]) => title === "Doctor changes")).toBe(false);
}
async function expectRepairedSettings(file: string, bind?: string) {
  const saved = JSON.parse(await readText(file));
  expect(saved.browser).toEqual({ enabled: false });
  expect(saved.logging.level).toBe("info");
  if (bind) {
    expect(saved.gateway.bind).toBe(bind);
  }
}

it.each([
  ["accepting repairs after an edit", true, true, false],
  ["accepting repairs without an edit", false, true, false],
  ["declining repairs after an edit", true, false, false],
  ["switching config paths to identical bytes", false, true, true],
] as const)("preserves saved settings when %s", (_name, saveEdit, accept, switchPath) =>
  withDoctorConfigPreflightHome(async (home) => {
    const config = createRepairableConfig(home);
    const configPath = await writeOpenClawConfig(home, config);
    const original = await readText(configPath);
    const edited = JSON.stringify({ ...config, logging: { ...config.logging, level: "debug" } });
    const otherPath = path.join(path.dirname(configPath), "other.json");
    if (switchPath) {
      await fs.writeFile(otherPath, original);
    }
    await withEnvAsync(
      { OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1", OPENCLAW_CONFIG_PATH: configPath },
      async () => {
        const confirm = repairConfirmation(async () => {
          if (switchPath) {
            setTestEnvValue("OPENCLAW_CONFIG_PATH", otherPath);
          } else if (saveEdit) {
            await fs.writeFile(configPath, edited);
          }
          return accept;
        });
        await using ctx = await prepareDoctorContext(configPath, { options: {}, confirm });
        expect(confirm).toHaveBeenCalled();
        await expect(runInitialConfigWriteHealth(ctx)).resolves.toBeUndefined();
        if (saveEdit || switchPath) {
          // The final writer must not revive a declined or refused candidate.
          await runWriteConfigHealth(ctx);
          for (const file of switchPath ? [configPath, otherPath] : [configPath]) {
            await expectBytes(file, switchPath ? original : edited);
            await expect(fs.access(`${file}.bak`)).rejects.toMatchObject({ code: "ENOENT" });
          }
          expect(ctx.configResultWriteCommitted).not.toBe(true);
          if (accept) {
            expectConflictWarning();
          }
          return;
        }
        await expectRepairedSettings(configPath);
        await expectBytes(`${configPath}.bak`, original);
        expect(ctx.configResultWriteCommitted).toBe(true);
        // A committed repair must retire the confirmation's stale source fingerprint.
        ctx.cfg = { ...ctx.cfg, gateway: { ...ctx.cfg.gateway, bind: "lan" } };
        await runWriteConfigHealth(ctx);
        await expectRepairedSettings(configPath, "lan");
      },
    );
  }),
);
type ActivationCase = [string, PluginEntryConfig, string[] | undefined, boolean, string[]?];

const optOut = { sessionCatalog: { enabled: false } };
const enabledEntry = { enabled: true, config: optOut };
const bothProviders = ["anthropic", "codex"];

it.each<ActivationCase>([
  ["a first-write opt-out with a non-Codex model", { config: optOut }, ["anthropic"], false],
  ["historical enablement without an allowlist", enabledEntry, undefined, true],
  ["historical enablement with an empty allowlist", enabledEntry, [], true],
  ["historical enablement with an expanded allowlist", enabledEntry, bothProviders, true],
  [
    "authored catalog settings",
    { ...enabledEntry, config: { sessionCatalog: { enabled: false, homes: [] } } },
    bothProviders,
    false,
  ],
  [
    "authored entry settings",
    { ...enabledEntry, hooks: { allowPromptInjection: false } },
    bothProviders,
    false,
  ],
  ["explicit disablement", { enabled: false, config: optOut }, ["anthropic"], false],
  ["a restrictive allowlist without Codex", enabledEntry, ["anthropic"], false, bothProviders],
])("preserves plugin choices and reports %s", (_name, entry, allow, warning, persistedAllow) =>
  withDoctorConfigPreflightHome(async (home) => {
    const configPath = await writeOpenClawConfig(home, {
      gateway: { mode: "local" },
      // Isolate the privacy seed from Doctor's separate implicit-default route repair.
      agents: { defaults: { model: "anthropic/claude-sonnet-4-6" } },
      plugins: { ...(allow === undefined ? {} : { allow }), entries: { codex: entry } },
    });
    const before = await readText(configPath);
    await using ctx = await prepareDoctorContext(configPath);
    expect(await readText(configPath)).toBe(before);
    const advisory = warningMessages("machine auto-enablement");

    expect(advisory).toEqual(
      warning
        ? [
            expect.stringMatching(
              /2026\.9\.3\/2026\.9\.4[\s\S]*cannot determine[\s\S]*If you did not enable Codex[\s\S]*plugins\.entries\.codex\.enabled=false[\s\S]*remove "codex" from plugins\.allow/u,
            ),
          ]
        : [],
    );

    await runInitialConfigWriteHealth(ctx);
    const saved = await readConfigFileSnapshot();
    expect(saved.valid).toBe(true);
    expect(saved.sourceConfig.plugins?.entries?.codex).toEqual(entry);
    expect(saved.sourceConfig.plugins?.allow).toEqual(persistedAllow ?? allow);
  }),
);
