import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readConfigFileSnapshot } from "../config/config.js";
import { writeOpenClawConfig } from "../config/test-helpers.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { runInitialConfigWriteHealth } from "../flows/doctor-health-contribution-runners.config.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { withEnvAsync } from "../test-utils/env.js";
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

  it.each(["accepted", "declined", "noninteractive update", "config drift"] as const)(
    "recovers the backed-up owner only with current consent: %s",
    async (scenario) => {
      await withDoctorConfigPreflightHome(async (home) => {
        const config = fixture(home);
        const configPath = await writeOpenClawConfig(home, config);
        const original = await fs.readFile(configPath, "utf8");
        const edited = JSON.stringify({ ...config, logging: { level: "debug" } });
        const reviewingHistory = scenario === "accepted" || scenario === "declined";
        await fs.writeFile(
          `${configPath}.bak`,
          reviewingHistory ? original : JSON.stringify(fixture(home, "ops")),
        );
        if (reviewingHistory) {
          await fs.writeFile(`${configPath}.bak.1`, JSON.stringify(fixture(home, "ops")));
          await fs.writeFile(`${configPath}.bak.2`, JSON.stringify(fixture(home, "research")));
        }
        const prompter = recoveryPrompter(async () => {
          if (scenario === "config drift") {
            await fs.writeFile(configPath, edited);
          }
          return scenario !== "declined";
        });
        await withEnvAsync(
          { OPENCLAW_UPDATE_IN_PROGRESS: scenario === "noninteractive update" ? "1" : undefined },
          async () => {
            const ctx = await prepareDoctorContext(
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
            if (scenario === "config drift") {
              await expect(fs.readFile(configPath, "utf8")).resolves.toBe(edited);
              expect(ctx.configWriteRefusal).toBe("config-conflict");
              return;
            }
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

  it.each(["store-roundtrip", "directory-alias", "retired-agent", "absent-history"])(
    "never invents ownership from %s",
    async (scenario) => {
      await withDoctorConfigPreflightHome(async (home) => {
        const currentDir = path.join(home, "current");
        const formerDir = path.join(home, "former");
        const alias = scenario === "directory-alias";
        if (alias) {
          await fs.mkdir(currentDir);
          await fs.symlink(currentDir, formerDir, "junction");
        }
        const configPath = await writeOpenClawConfig(
          home,
          fixture(home, undefined, alias ? path.join(currentDir, "sessions.json") : undefined),
        );
        if (scenario !== "absent-history") {
          await fs.writeFile(
            `${configPath}.bak`,
            JSON.stringify(
              fixture(
                home,
                scenario === "retired-agent" ? "removed" : "ops",
                scenario === "retired-agent"
                  ? undefined
                  : alias
                    ? path.join(formerDir, "sessions.json")
                    : path.join(home, "other-store.json"),
              ),
            ),
          );
        }
        if (scenario === "store-roundtrip") {
          await fs.writeFile(`${configPath}.bak.1`, JSON.stringify(fixture(home, "research")));
        }
        const prompter = recoveryPrompter(async () => true);
        const ctx = await prepareDoctorContext(configPath, { prompter });
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
