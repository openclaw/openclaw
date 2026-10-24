// Real-reader setup reruns retain the selected fleet owner across mutation and reopen.
import fs from "node:fs/promises";
import path from "node:path";
import { withTempHome } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import { upsertAuthProfileAsync } from "../../agents/auth-profiles/profiles.js";
import { loadAuthProfileStoreWithoutExternalProfilesAsync } from "../../agents/auth-profiles/store-runtime.js";
import { readConfigFileSnapshot, resetConfigRuntimeState } from "../../config/io.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { RuntimeEnv } from "../../runtime.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
} from "../../state/openclaw-agent-db.js";
import { closeStateDatabaseForTest } from "../../test-utils/database-cleanup.js";
import { runDoctorConfigPreflight } from "../doctor-config-preflight.js";
import { applyOnboardingPrimaryModel } from "../onboard-agent-target.js";
import type { applyNonInteractiveAuthChoice } from "./local/auth-choice.js";

const mocks = vi.hoisted(() => ({
  applyAuthChoice: vi.fn(),
  ensureOnboardingAgent: vi.fn(),
  ensureWorkspaceAndSessions: vi.fn(),
}));

vi.mock("../onboard-helpers.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../onboard-helpers.js")>()),
  ensureWorkspaceAndSessions: mocks.ensureWorkspaceAndSessions,
}));
vi.mock("../onboard-agent.js", () => ({ ensureOnboardingAgent: mocks.ensureOnboardingAgent }));
vi.mock("./local/auth-choice.js", () => ({
  applyNonInteractiveAuthChoice: mocks.applyAuthChoice,
}));

import { runNonInteractiveSetup } from "../onboard-non-interactive.js";

function expectFleet(agents: OpenClawConfig["agents"], entries: unknown) {
  expect(agents?.entries).toEqual(entries);
  expect(agents).not.toHaveProperty("list");
  expect(agents?.ownership).toBe("explicit");
  expect(agents?.defaults?.systemAgent).toEqual({ agentId: "beta" });
}

afterEach(async () => {
  vi.resetAllMocks();
  await closeOpenClawAgentDatabasesAsync();
  closeOpenClawAgentDatabasesForTest();
  await closeStateDatabaseForTest();
  resetConfigRuntimeState();
});

describe("local setup fleet owner persistence", () => {
  it.each([
    { legacy: true, include: false },
    { legacy: true, include: true },
    { legacy: false, include: false },
    { legacy: false, include: true },
  ])(
    "preserves a fleet through Doctor and two real setup writes: %j",
    async ({ legacy, include }) => {
      const { ensureOnboardingAgent } =
        await vi.importActual<typeof import("../onboard-agent.js")>("../onboard-agent.js");
      mocks.ensureOnboardingAgent.mockImplementation(ensureOnboardingAgent);
      await withTempHome(async (rawHome) => {
        const home = await fs.realpath(rawHome);
        const stateDir = path.join(home, ".openclaw");
        const configPath = path.join(stateDir, "openclaw.json");
        const includePath = path.join(stateDir, "roster.json");
        const read = (file = configPath) => fs.readFile(file, "utf8");
        const write = (value: unknown, file = configPath) =>
          fs.writeFile(file, JSON.stringify(value));
        const profileId = "fixture:setup";
        const readProfile = async (dir: string) =>
          (await loadAuthProfileStoreWithoutExternalProfilesAsync(dir)).profiles[profileId];
        const workspace = path.join(home, "existing-workspace");
        const agentDir = path.join(stateDir, "agents", "beta", "agent");
        const defaults = { workspace, model: "fixture/shared" };
        const selected = "fixture/selected";
        const models = ["alpha", "beta", "shared", "selected"].map((id) => ({ id, name: id }));
        const provider = { api: "openai-completions", baseUrl: "https://fixture.test", models };
        const entries = {
          alpha: { model: "fixture/alpha", workspace: path.join(home, "alpha-workspace") },
          beta: { model: "fixture/beta", ...(!legacy ? { workspace } : {}), agentDir },
        };
        // The legacy default is deliberately neither the first nor lexical agent.
        const list = [
          { id: "alpha", ...entries.alpha },
          { id: "beta", default: true, ...entries.beta },
        ];
        const roster = legacy ? { list } : { entries };
        const includeRaw = JSON.stringify(roster);
        if (include) {
          await fs.writeFile(includePath, includeRaw);
        }
        const bindings = [
          { type: "route", agentId: "alpha", match: { channel: "discord", accountId: "*" } },
        ];
        const raw = JSON.stringify({
          agents: {
            ...(include ? { $include: "./roster.json" } : roster),
            ...(!legacy ? { ownership: "explicit" } : {}),
            defaults: { ...defaults, ...(!legacy ? { systemAgent: { agentId: "beta" } } : {}) },
          },
          bindings,
          gateway: { mode: "local", port: 24680 },
          models: { providers: { fixture: provider } },
        });
        await fs.writeFile(configPath, raw);
        resetConfigRuntimeState();
        const before = await readConfigFileSnapshot();
        expect(before.valid, JSON.stringify(before.issues)).toBe(!legacy);
        expect(before.sourceConfig.agents).toMatchObject(roster);
        expect(await read()).toBe(raw);
        if (include) {
          expect(await read(includePath)).toBe(includeRaw);
        }
        const canonicalEntries = { ...entries, beta: { ...entries.beta, workspace } };
        let setupIncludeRaw = includeRaw;
        if (legacy) {
          if (include) {
            // Repair the root-owned roles before re-splitting the included roster.
            await write(before.sourceConfig);
            resetConfigRuntimeState();
          }
          await runDoctorConfigPreflight({
            observe: false,
            invocationPurpose: "doctor",
            repairPrefixedConfig: true,
            doctorOnlyStateMigrations: true,
            preparePluginMetadataSnapshot: true,
          });
          resetConfigRuntimeState();
          const repaired = await readConfigFileSnapshot();
          expect(repaired.valid, JSON.stringify(repaired.issues)).toBe(true);
          expectFleet(repaired.sourceConfig.agents, canonicalEntries);
          expect(repaired.sourceConfig.bindings).toEqual(bindings);
          if (include) {
            expect(await read(includePath)).toBe(includeRaw);
            setupIncludeRaw = JSON.stringify({ entries: canonicalEntries });
            await fs.writeFile(includePath, setupIncludeRaw);
            const rootOwnedAgents = { ...repaired.sourceConfig.agents };
            delete rootOwnedAgents.entries;
            await write({
              ...repaired.sourceConfig,
              agents: { $include: "./roster.json", ...rootOwnedAgents },
            });
            resetConfigRuntimeState();
            expect((await readConfigFileSnapshot()).valid).toBe(true);
          }
        }
        const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() } as unknown as RuntimeEnv;
        mocks.applyAuthChoice.mockImplementation(
          async ({ nextConfig, target }: Parameters<typeof applyNonInteractiveAuthChoice>[0]) => {
            expect(target).toEqual({ agentId: "beta", agentDir, workspaceDir: workspace });
            await upsertAuthProfileAsync({
              agentDir: target.agentDir,
              profileId,
              credential: { type: "api_key", provider: "fixture", key: "synthetic-setup-key" },
            });
            // Keep included entries file-owned; edit root-owned models.
            return include
              ? { ...nextConfig }
              : applyOnboardingPrimaryModel(nextConfig, target, selected);
          },
        );

        for (let rerun = 0; rerun < 2; rerun += 1) {
          await runNonInteractiveSetup(
            {
              nonInteractive: true,
              mode: "local",
              agentName: "ignored",
              workspace: path.join(home, "requested-workspace"),
              authChoice: "fixture-api-key",
              skipBootstrap: true,
              skipSkills: true,
              skipHealth: true,
              installDaemon: false,
            },
            runtime,
          );
          const onboarded = await mocks.ensureOnboardingAgent.mock.results[rerun]?.value;
          expect(onboarded).toMatchObject({ agentId: "beta", createdAgent: false });
          expect(mocks.ensureWorkspaceAndSessions).toHaveBeenLastCalledWith(
            workspace,
            runtime,
            expect.objectContaining({ agentId: "beta", skipBootstrap: true }),
          );
          await closeOpenClawAgentDatabasesAsync(stateDir);
          closeOpenClawAgentDatabasesForTest(stateDir);
          await closeStateDatabaseForTest();
          resetConfigRuntimeState();
          const reopened = await readConfigFileSnapshot();
          expect(reopened.valid, JSON.stringify(reopened.issues)).toBe(true);
          const expectedEntries = {
            ...canonicalEntries,
            beta: include
              ? canonicalEntries.beta
              : {
                  ...canonicalEntries.beta,
                  model: { primary: selected },
                  models: { [selected]: {} },
                },
          };
          const { agents, gateway, hooks } = reopened.sourceConfig;
          expectFleet(agents, expectedEntries);
          expect(agents?.defaults).toMatchObject({ ...defaults, skipBootstrap: true });
          expect(gateway?.port).toBe(24680);
          expect(hooks?.internal?.entries?.["session-memory"]?.enabled).toBe(true);
          expect(reopened.sourceConfig.bindings).toEqual(bindings);
          if (include) {
            expect(await read(includePath)).toBe(setupIncludeRaw);
            expect(JSON.parse(await read()).agents.$include).toBe("./roster.json");
          } else {
            const persisted = JSON.parse(await read());
            expectFleet(persisted.agents, expectedEntries);
          }
          expect(await readProfile(agentDir)).toMatchObject({ provider: "fixture" });
          for (const nonOwner of ["alpha", "ignored"]) {
            const profile = await readProfile(path.join(stateDir, "agents", nonOwner, "agent"));
            expect(profile, `credentials must not be stored for ${nonOwner}`).toBeUndefined();
          }
        }
        expect(runtime.exit).not.toHaveBeenCalled();
        expect(runtime.error).toHaveBeenCalledWith(
          expect.stringContaining("existing agents keep their current workspace"),
        );
      });
    },
  );
});
