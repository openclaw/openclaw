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

  it.each([true, false])(
    "offers the latest backed-up owner and honors acceptance=%s",
    async (accept) => {
      await withDoctorConfigPreflightHome(async (home) => {
        const config = fixture(home);
        const configPath = await writeOpenClawConfig(home, config);
        const original = await fs.readFile(configPath, "utf8");
        await fs.writeFile(`${configPath}.bak`, original);
        await fs.writeFile(`${configPath}.bak.1`, JSON.stringify(fixture(home, "ops")));
        await fs.writeFile(`${configPath}.bak.2`, JSON.stringify(fixture(home, "research")));
        const prompter = recoveryPrompter(async () => accept);
        const ctx = await prepareDoctorContext(configPath, { prompter });
        expect(prompter.confirmRuntimeRepair).toHaveBeenCalledWith({
          message: expect.stringContaining(`${configPath}.bak.1`),
          initialValue: false,
          requiresInteractiveConfirmation: true,
        });
        await runInitialConfigWriteHealth(ctx);
        const saved = await readConfigFileSnapshot();
        expect(saved.sourceConfig.agents?.defaults?.sessionStore?.agentId).toBe(
          accept ? "ops" : undefined,
        );
        expect(saved.sourceConfig.agents?.defaults?.authInheritance).toEqual({ agentId: "ops" });
        if (accept) {
          await expect(fs.readFile(`${configPath}.bak`, "utf8")).resolves.toBe(original);
          expect(
            note.mock.calls.some(([message]) =>
              message.includes("Restored agents.defaults.sessionStore.agentId"),
            ),
          ).toBe(true);
        } else {
          expect(
            note.mock.calls.some(([message]) =>
              message.includes("openclaw config set agents.defaults.sessionStore.agentId ops"),
            ),
          ).toBe(true);
        }
      });
    },
  );

  it("keeps noninteractive update recovery advisory", async () => {
    await withDoctorConfigPreflightHome(async (home) => {
      const configPath = await writeOpenClawConfig(home, fixture(home));
      await fs.writeFile(`${configPath}.bak`, JSON.stringify(fixture(home, "ops")));
      await withEnvAsync({ OPENCLAW_UPDATE_IN_PROGRESS: "1" }, async () => {
        const ctx = await prepareDoctorContext(configPath, {
          options: { repair: true, yes: true, nonInteractive: true },
        });
        expect(ctx.cfg.agents?.defaults?.sessionStore?.agentId).toBeUndefined();
        expect(
          note.mock.calls.some(([message]) =>
            message.includes("removal may have been intentional"),
          ),
        ).toBe(true);
      });
    });
  });

  it.each(["different-store", "store-roundtrip", "retired-agent", "absent-history"])(
    "never invents ownership from %s",
    async (scenario) => {
      await withDoctorConfigPreflightHome(async (home) => {
        const configPath = await writeOpenClawConfig(home, fixture(home));
        if (scenario !== "absent-history") {
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

  it("does not use today's directory aliases as historical store ownership", async () => {
    await withDoctorConfigPreflightHome(async (home) => {
      const currentDir = path.join(home, "current");
      const formerDir = path.join(home, "former");
      await fs.mkdir(currentDir);
      await fs.symlink(currentDir, formerDir, "junction");
      const configPath = await writeOpenClawConfig(
        home,
        fixture(home, undefined, path.join(currentDir, "sessions.json")),
      );
      await fs.writeFile(
        `${configPath}.bak`,
        JSON.stringify(fixture(home, "ops", path.join(formerDir, "sessions.json"))),
      );
      const prompter = recoveryPrompter(async () => true);
      const ctx = await prepareDoctorContext(configPath, { prompter });
      expect(prompter.confirmRuntimeRepair).not.toHaveBeenCalled();
      expect(ctx.cfg.agents?.defaults?.sessionStore?.agentId).toBeUndefined();
    });
  });

  it("refuses restoration after the current config changes during confirmation", async () => {
    await withDoctorConfigPreflightHome(async (home) => {
      const configPath = await writeOpenClawConfig(home, fixture(home));
      await fs.writeFile(`${configPath}.bak`, JSON.stringify(fixture(home, "ops")));
      const edited = JSON.stringify({ ...fixture(home), logging: { level: "debug" } });
      const prompter = recoveryPrompter(async () => {
        await fs.writeFile(configPath, edited);
        return true;
      });
      const ctx = await prepareDoctorContext(configPath, { prompter });
      await runInitialConfigWriteHealth(ctx);
      await expect(fs.readFile(configPath, "utf8")).resolves.toBe(edited);
      expect(ctx.configWriteRefusal).toBe("config-conflict");
    });
  });
});
