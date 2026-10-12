import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
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
import { withDoctorConfigPreflightHome } from "./doctor-config-preflight.test-support.js";
import { createDoctorPrompter } from "./doctor-prompter.js";

const note = vi.hoisted(() => vi.fn<(message: string, title?: string) => void>());
vi.mock("../../packages/terminal-core/src/note.js", () => ({ note }));

function fixture(home: string, owner?: string, store?: string): OpenClawConfig {
  return {
    agents: {
      ownership: "explicit",
      entries: Object.fromEntries(
        ["ops", "research", "writer", "reviewer"].map((id) => [
          id,
          { workspace: path.join(home, "workspaces", id) },
        ]),
      ),
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

describe("Doctor session-store owner recovery", () => {
  afterEach(() => {
    note.mockClear();
    closeOpenClawStateDatabaseForTest();
  });

  it.each(["accepted", "declined", "noninteractive update"] as const)(
    "recovers the backed-up owner only with current consent: %s",
    async (scenario) => {
      await withDoctorConfigPreflightHome(async (home) => {
        const config = fixture(home);
        const configPath = await writeOpenClawConfig(home, config);
        const original = await fs.readFile(configPath, "utf8");
        const reviewingHistory = scenario === "accepted" || scenario === "declined";
        await fs.writeFile(
          `${configPath}.bak`,
          reviewingHistory ? original : JSON.stringify(fixture(home, "ops")),
        );
        if (reviewingHistory) {
          await fs.writeFile(`${configPath}.bak.1`, JSON.stringify(fixture(home, "ops")));
          await fs.writeFile(`${configPath}.bak.2`, JSON.stringify(fixture(home, "research")));
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
              expect(
                note.mock.calls.some(([message]) =>
                  message.includes("removal may have been intentional"),
                ),
              ).toBe(true);
              return;
            }
            expect(prompter.confirmRuntimeRepair).toHaveBeenCalledWith({
              message: expect.stringContaining(`${configPath}.bak${reviewingHistory ? ".1" : ""}`),
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
              await expect(fs.readFile(`${configPath}.bak`, "utf8")).resolves.toBe(original);
            }
            expect(
              note.mock.calls.some(([message]) =>
                message.includes(
                  scenario === "accepted"
                    ? "Restored agents.defaults.sessionStore.agentId"
                    : "openclaw config set agents.defaults.sessionStore.agentId ops",
                ),
              ),
            ).toBe(true);
          },
        );
      });
    },
  );

  it.each(["store-roundtrip", "retired-agent"])(
    "never invents ownership from %s",
    async (scenario) => {
      await withDoctorConfigPreflightHome(async (home) => {
        const configPath = await writeOpenClawConfig(home, fixture(home));
        await fs.writeFile(
          `${configPath}.bak`,
          JSON.stringify(
            fixture(
              home,
              scenario === "retired-agent" ? "removed" : "ops",
              scenario === "retired-agent" ? undefined : path.join(home, "other-store.json"),
            ),
          ),
        );
        if (scenario === "store-roundtrip") {
          await fs.writeFile(`${configPath}.bak.1`, JSON.stringify(fixture(home, "research")));
        }
        const prompter = recoveryPrompter(async () => true);
        await using ctx = await prepareDoctorContext(configPath, { prompter });
        expect(prompter.confirmRuntimeRepair).not.toHaveBeenCalled();
        expect(ctx.cfg.agents?.defaults?.sessionStore?.agentId).toBeUndefined();
        if (scenario === "retired-agent") {
          expect(
            note.mock.calls.some(([message]) =>
              message.includes("Re-author agents.defaults.sessionStore.agentId"),
            ),
          ).toBe(true);
        }
      });
    },
  );
});

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
  const warnings = note.mock.calls
    .filter(([, title]) => title === "Doctor warnings")
    .map(([message]) => message)
    .join("\n");
  expect(warnings).toContain("changed");
  expect(warnings).toContain("These config fixes were not written.");
  expect(warnings).toMatch(/rerun "openclaw doctor"/i);
  expect(note.mock.calls.some(([, title]) => title === "Doctor changes")).toBe(false);
}

describe("Doctor repair confirmation conflicts", () => {
  afterEach(() => {
    note.mockClear();
    closeOpenClawStateDatabaseForTest();
    vi.restoreAllMocks();
  });

  it.each([
    { scenario: "accepting repairs after an edit", saveEdit: true, accept: true },
    { scenario: "accepting repairs without an edit", saveEdit: false, accept: true },
    { scenario: "declining repairs after an edit", saveEdit: true, accept: false },
  ])("preserves saved settings when $scenario", async ({ saveEdit, accept }) => {
    await withDoctorConfigPreflightHome(async (home) => {
      await withEnvAsync({ OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" }, async () => {
        const config = createRepairableConfig(home);
        const configPath = await writeOpenClawConfig(home, config);
        const original = await fs.readFile(configPath, "utf8");
        const edited = JSON.stringify(
          { ...config, logging: { ...config.logging, level: "debug" } },
          null,
          2,
        );
        let confirmationShown = false;
        await using ctx = await prepareDoctorContext(configPath, {
          options: {},
          confirm: async ({ message }) => {
            expect(message).toBe("Apply recommended config repairs now?");
            confirmationShown = true;
            if (saveEdit) {
              await fs.writeFile(configPath, edited);
            }
            return accept;
          },
        });
        expect(confirmationShown).toBe(true);

        await expect(runInitialConfigWriteHealth(ctx)).resolves.toBeUndefined();

        if (saveEdit) {
          // The final writer must not revive a declined or refused candidate.
          await runWriteConfigHealth(ctx);
          await expect(fs.readFile(configPath, "utf8")).resolves.toBe(edited);
          await expect(fs.access(`${configPath}.bak`)).rejects.toMatchObject({ code: "ENOENT" });
          expect(ctx.configResultWriteCommitted).not.toBe(true);
          if (accept) {
            expectConflictWarning();
          }
          return;
        }

        const saved = JSON.parse(await fs.readFile(configPath, "utf8"));
        expect(saved.browser).toEqual({ enabled: false });
        expect(saved.logging.level).toBe("info");
        await expect(fs.readFile(`${configPath}.bak`, "utf8")).resolves.toBe(original);
        expect(ctx.configResultWriteCommitted).toBe(true);

        // A later health repair is based on the committed candidate, so the
        // confirmation's original source must no longer block that write.
        ctx.cfg = { ...ctx.cfg, gateway: { ...ctx.cfg.gateway, bind: "lan" } };
        await runWriteConfigHealth(ctx);
        const afterHealthRepair = JSON.parse(await fs.readFile(configPath, "utf8"));
        expect(afterHealthRepair.gateway.bind).toBe("lan");
        expect(afterHealthRepair.browser).toEqual({ enabled: false });
        expect(afterHealthRepair.logging.level).toBe("info");
      });
    });
  });

  it("refuses a config path switch during confirmation even when both files have identical bytes", async () => {
    await withDoctorConfigPreflightHome(async (home) => {
      await withEnvAsync({ OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" }, async () => {
        const configPath = await writeOpenClawConfig(home, createRepairableConfig(home));
        const original = await fs.readFile(configPath, "utf8");
        const otherPath = path.join(path.dirname(configPath), "other.json");
        await fs.writeFile(otherPath, original);

        await withEnvAsync({ OPENCLAW_CONFIG_PATH: configPath }, async () => {
          let confirmationShown = false;
          await using ctx = await prepareDoctorContext(configPath, {
            options: {},
            confirm: async ({ message }) => {
              expect(message).toBe("Apply recommended config repairs now?");
              confirmationShown = true;
              setTestEnvValue("OPENCLAW_CONFIG_PATH", otherPath);
              return true;
            },
          });
          expect(confirmationShown).toBe(true);

          await expect(runInitialConfigWriteHealth(ctx)).resolves.toBeUndefined();
          await runWriteConfigHealth(ctx);

          for (const file of [configPath, otherPath]) {
            await expect(fs.readFile(file, "utf8")).resolves.toBe(original);
            await expect(fs.access(`${file}.bak`)).rejects.toMatchObject({ code: "ENOENT" });
          }
          expect(ctx.configResultWriteCommitted).not.toBe(true);
          expectConflictWarning();
        });
      });
    });
  });
});

type ActivationCase = {
  name: string;
  entry: PluginEntryConfig;
  allow?: string[];
  persistedAllow?: string[];
  warning: boolean;
};

const optOut = { sessionCatalog: { enabled: false } };

describe("Doctor Codex activation advisory", () => {
  afterEach(() => {
    note.mockClear();
    closeOpenClawStateDatabaseForTest();
  });

  it.each<ActivationCase>([
    {
      name: "a first-write opt-out with a non-Codex model",
      entry: { config: optOut },
      allow: ["anthropic"],
      warning: false,
    },
    {
      name: "historical enablement without an allowlist",
      entry: { enabled: true, config: optOut },
      warning: true,
    },
    {
      name: "historical enablement with an empty allowlist",
      entry: { enabled: true, config: optOut },
      allow: [],
      warning: true,
    },
    {
      name: "historical enablement with an expanded allowlist",
      entry: { enabled: true, config: optOut },
      allow: ["anthropic", "codex"],
      warning: true,
    },
    {
      name: "authored catalog settings",
      entry: { enabled: true, config: { sessionCatalog: { enabled: false, homes: [] } } },
      allow: ["anthropic", "codex"],
      warning: false,
    },
    {
      name: "authored entry settings",
      entry: { enabled: true, config: optOut, hooks: { allowPromptInjection: false } },
      allow: ["anthropic", "codex"],
      warning: false,
    },
    {
      name: "explicit disablement",
      entry: { enabled: false, config: optOut },
      allow: ["anthropic"],
      warning: false,
    },
    {
      name: "a restrictive allowlist without Codex",
      entry: { enabled: true, config: optOut },
      allow: ["anthropic"],
      persistedAllow: ["anthropic", "codex"],
      warning: false,
    },
  ])(
    "preserves plugin choices and reports $name",
    async ({ entry, allow, persistedAllow, warning }) => {
      await withDoctorConfigPreflightHome(async (home) => {
        const configPath = await writeOpenClawConfig(home, {
          gateway: { mode: "local" },
          // Isolate the privacy seed from Doctor's separate implicit-default route repair.
          agents: { defaults: { model: "anthropic/claude-sonnet-4-6" } },
          plugins: { ...(allow === undefined ? {} : { allow }), entries: { codex: entry } },
        });
        const before = await fs.readFile(configPath, "utf8");
        await using ctx = await prepareDoctorContext(configPath);
        expect(await fs.readFile(configPath, "utf8")).toBe(before);
        const advisory = note.mock.calls
          .filter(
            ([message, title]) =>
              title === "Doctor warnings" && message.includes("machine auto-enablement"),
          )
          .map(([message]) => message);

        if (warning) {
          expect(advisory).toHaveLength(1);
          expect(advisory[0]).toContain("2026.9.3/2026.9.4");
          expect(advisory[0]).toContain("cannot determine");
          expect(advisory[0]).toContain("If you did not enable Codex");
          expect(advisory[0]).toContain("plugins.entries.codex.enabled=false");
          expect(advisory[0]).toContain('remove "codex" from plugins.allow');
        } else {
          expect(advisory).toEqual([]);
        }

        await runInitialConfigWriteHealth(ctx);
        const saved = await readConfigFileSnapshot();
        expect(saved.valid).toBe(true);
        expect(saved.sourceConfig.plugins?.entries?.codex).toEqual(entry);
        expect(saved.sourceConfig.plugins?.allow).toEqual(persistedAllow ?? allow);
      });
    },
  );
});
