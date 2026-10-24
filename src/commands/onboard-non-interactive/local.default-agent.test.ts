// Non-interactive setup tests keep provisioning and output on the configured default agent.
import fs from "node:fs/promises";
import path from "node:path";
import { withTempHome } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readConfigFileSnapshot, resetConfigRuntimeState } from "../../config/io.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { RuntimeEnv } from "../../runtime.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import type { OnboardOptions } from "../onboard-types.js";

const mocks = vi.hoisted(() => ({
  applyAuthChoice: vi.fn(),
  applyGatewayConfig: vi.fn(),
  commitConfig: vi.fn(),
  ensureOnboardingAgent: vi.fn(),
  ensureWorkspaceAndSessions: vi.fn(),
  inferAuthChoice: vi.fn(),
  logConfigUpdated: vi.fn(),
}));

vi.mock("../../config/logging.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../config/logging.js")>()),
  logConfigUpdated: mocks.logConfigUpdated,
}));

vi.mock("../onboard-helpers.js", () => ({
  DEFAULT_WORKSPACE: "/tmp/default-workspace",
  applyWizardMetadata: (config: OpenClawConfig) => config,
  ensureWorkspaceAndSessions: mocks.ensureWorkspaceAndSessions,
  resolveLocalControlUiProbeLinks: vi.fn(),
  waitForGatewayReachable: vi.fn(),
}));

vi.mock("./config-write.js", () => ({
  commitNonInteractiveOnboardConfig: mocks.commitConfig,
}));

// mock-isolation: The setup orchestrator observes a selected agent result without creating agents or migrating sessions.
vi.mock("../onboard-agent.js", () => ({ ensureOnboardingAgent: mocks.ensureOnboardingAgent }));

vi.mock("./local/auth-choice.js", () => ({
  applyNonInteractiveAuthChoice: mocks.applyAuthChoice,
}));

vi.mock("./local/auth-choice-inference.js", () => ({
  inferAuthChoiceFromFlags: mocks.inferAuthChoice,
}));

vi.mock("./local/gateway-config.js", () => ({
  applyNonInteractiveGatewayConfig: mocks.applyGatewayConfig,
}));

import { runNonInteractiveSetup } from "../onboard-non-interactive.js";
import { runNonInteractiveLocalSetup } from "./local.js";

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  resetConfigRuntimeState();
});

const runtime: RuntimeEnv = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };

const localOptions = {
  nonInteractive: true,
  mode: "local",
  skipHooks: true,
  skipSkills: true,
  skipHealth: true,
} satisfies OnboardOptions;

function runLocal(
  opts: Partial<OnboardOptions> = {},
  baseConfig: OpenClawConfig = {},
  sourceConfigBeforeMigrations = baseConfig,
) {
  return runNonInteractiveLocalSetup({
    opts: { ...localOptions, ...opts },
    runtime,
    baseConfig,
    sourceConfigBeforeMigrations,
  });
}

function runSetup(opts: OnboardOptions) {
  return runNonInteractiveSetup({ ...localOptions, ...opts }, runtime);
}

const lastOutput = () => JSON.parse(String(vi.mocked(runtime.log).mock.calls.at(-1)?.[0]));

function expectWorkspace(agentId: string, workspace: string) {
  expect(mocks.ensureWorkspaceAndSessions).toHaveBeenCalledWith(
    workspace,
    runtime,
    expect.objectContaining({ agentId }),
  );
  expect(lastOutput()).toMatchObject({ ok: true, workspace });
}

describe("runNonInteractiveLocalSetup default-agent ownership", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.applyAuthChoice.mockImplementation(
      async ({ nextConfig }: { nextConfig: OpenClawConfig }) => nextConfig,
    );
    mocks.applyGatewayConfig.mockImplementation(
      ({ nextConfig }: { nextConfig: OpenClawConfig }) => ({
        nextConfig,
        port: 18789,
        bind: "loopback",
        authMode: "token",
        tailscaleMode: "off",
      }),
    );
    // An early config conflict can leave the one-shot real writer unused.
    mocks.commitConfig
      .mockReset()
      .mockImplementation(async ({ nextConfig }: { nextConfig: OpenClawConfig }) => nextConfig);
    mocks.ensureOnboardingAgent.mockImplementation(
      async ({ config }: { config: OpenClawConfig }) => ({
        config,
        agentId: "ops",
        bootstrapPending: false,
      }),
    );
    mocks.inferAuthChoice.mockReturnValue({ matches: [] });
  });

  it.each([
    [".openclaw", undefined, false, "/tmp/default-workspace"],
    ["scratch-state", "explicit-workspace", false, "explicit-workspace"],
    ["scratch-state", "   ", false, "scratch-state/workspace"],
    ["scratch-state", undefined, true, "scratch-state/workspace"],
  ] as const)(
    "provisions workspace: state=%s env=%s blankOptions=%s",
    async (stateDir, envWorkspace, blankOptions, expected) => {
      await withTempHome(
        async (home) => {
          const expectedWorkspace = path.isAbsolute(expected)
            ? expected
            : path.join(home, expected);
          await runLocal(
            { ...(blankOptions ? { workspace: "   " } : {}), json: true },
            {
              agents: {
                entries: { ops: {} },
                ...(blankOptions ? { defaults: { workspace: "\t" } } : {}),
              },
            },
            {},
          );

          expectWorkspace("ops", expectedWorkspace);
          expect(mocks.commitConfig.mock.calls[0]?.[0].nextConfig.agents.defaults.workspace).toBe(
            expectedWorkspace,
          );
        },
        {
          env: {
            OPENCLAW_HOME: (home) => home,
            OPENCLAW_STATE_DIR: (home) => path.join(home, stateDir),
            OPENCLAW_WORKSPACE_DIR: (home) =>
              envWorkspace?.trim() ? path.join(home, envWorkspace) : envWorkspace,
          },
        },
      );
    },
  );

  it.each([
    { saved: undefined, requested: undefined, expected: "npm", skipSkills: false },
    { saved: "yarn", requested: undefined, expected: "yarn", skipSkills: false },
    { saved: "yarn", requested: "npm", expected: "npm", skipSkills: false },
    { saved: "bun", requested: "pnpm", expected: "pnpm", skipSkills: false },
    { saved: "pnpm", requested: "bun", expected: "bun", skipSkills: false },
    { saved: "yarn", requested: "npm", expected: "yarn", skipSkills: true },
  ] as const)(
    "records saved $saved and requested $requested skills manager as $expected",
    ({ saved, requested, expected, skipSkills }) =>
      withTempHome(async () => {
        const baseConfig: OpenClawConfig = {
          agents: { entries: { ops: {} } },
          skills: { install: { nodeManager: saved, preferBrew: false } },
        };
        await runLocal({ skipSkills, nodeManager: requested }, baseConfig);

        expect(mocks.commitConfig.mock.calls[0]?.[0].nextConfig.skills.install).toEqual({
          nodeManager: expected,
          preferBrew: false,
        });
        expect(baseConfig.skills?.install?.nodeManager).toBe(saved);
        if (skipSkills) {
          expect(mocks.commitConfig.mock.calls[0]?.[0].nextConfig.skills).toBe(baseConfig.skills);
          expect(baseConfig.skills?.install).toEqual({ nodeManager: "yarn", preferBrew: false });
        }
      }),
  );

  it.each([
    ["gateway", false],
    ["ambiguous", false],
    ["ambiguous", true],
  ] as const)(
    "rejects %s options before auth, agent creation, or writes (json: %s)",
    async (failure, json) => {
      if (failure === "gateway") {
        mocks.applyGatewayConfig.mockReturnValue(null);
        await runLocal({ authChoice: "demo-api-key", gatewayBind: "custom" });
        expect(mocks.applyGatewayConfig).toHaveBeenCalledOnce();
      } else {
        mocks.inferAuthChoice.mockReturnValue({
          matches: [
            { optionKey: "openaiApiKey", authChoice: "openai-api-key", label: "--openai-api-key" },
            {
              optionKey: "anthropicApiKey",
              authChoice: "anthropic-api-key",
              label: "--anthropic-api-key",
            },
          ],
        });

        await runLocal({
          openaiApiKey: "openai-test-key",
          anthropicApiKey: "anthropic-test-key",
          json,
        });

        expect(runtime.error).toHaveBeenCalledWith(
          expect.stringContaining("Multiple API key flags were provided"),
        );
        expect(runtime.exit).toHaveBeenCalledWith(1);
        if (json) {
          const message = [
            "Multiple API key flags were provided for non-interactive setup.",
            "Use a single provider flag or pass --auth-choice explicitly.",
            "Flags: --openai-api-key, --anthropic-api-key",
          ].join("\n");
          const payload = {
            ok: false,
            error: { type: "cli_error", message },
            phase: "options",
            message,
          };
          expect(runtime.log).toHaveBeenCalledWith(JSON.stringify(payload, null, 2));
        } else {
          expect(runtime.log).not.toHaveBeenCalled();
        }
        expect(mocks.applyGatewayConfig).not.toHaveBeenCalled();
      }
      expect(mocks.applyAuthChoice).not.toHaveBeenCalled();
      expect(mocks.ensureOnboardingAgent).not.toHaveBeenCalled();
      expect(mocks.commitConfig).not.toHaveBeenCalled();
      expect(mocks.ensureWorkspaceAndSessions).not.toHaveBeenCalled();
    },
  );

  type OwnerCase = { label: string } & (
    | { fresh: true; agents?: OpenClawConfig["agents"]; legacyState?: boolean; agentName?: string }
    | { fresh: false; agentId: string; include?: boolean; explicit?: boolean }
  );
  const ownerCases: OwnerCase[] = [
    { label: "fresh unnamed", fresh: true },
    { label: "fresh named", fresh: true, agentName: "robby" },
    { label: "rosterless", fresh: true, agents: {}, agentName: "robby" },
    { label: "empty keyed roster", fresh: true, agents: { entries: {} }, agentName: "robby" },
    { label: "legacy workspace", fresh: true, agents: {}, legacyState: true, agentName: "robby" },
    { label: "main", fresh: false, agentId: "main" },
    { label: "ops", fresh: false, agentId: "ops" },
    { label: "included main", fresh: false, agentId: "main", include: true },
    { label: "explicit ops", fresh: false, agentId: "ops", explicit: true },
  ];
  it.each(ownerCases)("keeps auth and provisioning on $label ownership", (testCase) =>
    withTempHome(async (rawHome) => {
      const home = await fs.realpath(rawHome);
      const configDir = path.join(home, ".openclaw");
      const write = (name: string, value: unknown) =>
        fs.writeFile(path.join(configDir, name), JSON.stringify(value));
      const agentId = testCase.fresh ? (testCase.agentName ?? "main") : testCase.agentId;
      const agentDir = path.join(configDir, "agents", agentId, "agent");
      const workspace = path.join(
        home,
        testCase.fresh ? "requested-workspace" : "global-workspace",
      );
      let expectedWorkspace = workspace;
      let entries: NonNullable<OpenClawConfig["agents"]>["entries"];
      if (testCase.fresh) {
        const oldWorkspace = path.join(home, "old-workspace");
        if (testCase.legacyState) {
          expectedWorkspace = oldWorkspace;
        } else {
          // withTempHome seeds main sessions; model a first install.
          await fs.rm(path.join(configDir, "agents"), { recursive: true });
        }
        if (testCase.agents) {
          await fs.mkdir(configDir, { recursive: true });
          await write("openclaw.json", {
            agents: { ...testCase.agents, defaults: { workspace: oldWorkspace } },
          });
        }
        resetConfigRuntimeState();
        const snapshot = await readConfigFileSnapshot();
        expect(snapshot).toMatchObject({ valid: true, exists: testCase.agents !== undefined });
      } else {
        expectedWorkspace = agentId === "main" ? workspace : path.join(home, "ops-workspace");
        entries = {
          ...(testCase.explicit ? { main: {} } : {}),
          [agentId]: agentId === "main" ? {} : { agentDir, workspace: expectedWorkspace },
        };
        if (testCase.include) {
          await write("roster.json", { agents: { entries } });
        }
        await write("openclaw.json", {
          ...(testCase.include ? { $include: "./roster.json" } : {}),
          agents: {
            ...(!testCase.include ? { entries } : {}),
            ...(testCase.explicit ? { ownership: "explicit" } : {}),
            defaults: { workspace, ...(testCase.explicit ? { systemAgent: { agentId } } : {}) },
          },
        });
        resetConfigRuntimeState();
      }
      const newEntry = testCase.fresh
        ? {
            [agentId]: {
              ...(testCase.agentName ? { name: testCase.agentName } : {}),
              workspace: expectedWorkspace,
            },
          }
        : undefined;
      mocks.ensureOnboardingAgent.mockImplementationOnce(
        async ({ config }: { config: OpenClawConfig }) => ({
          config: testCase.fresh
            ? {
                ...config,
                agents: { ...config.agents, entries: newEntry },
              }
            : config,
          agentId,
          bootstrapPending: testCase.fresh,
          createdAgent: testCase.fresh,
        }),
      );
      await runSetup({
        agentName: testCase.fresh ? testCase.agentName : "robby",
        installDaemon: testCase.fresh ? undefined : false,
        workspace,
        authChoice: "demo-api-key",
        json: true,
      });
      const auth = mocks.applyAuthChoice.mock.calls[0]?.[0];
      expect(auth?.target).toEqual({ agentId, agentDir, workspaceDir: expectedWorkspace });
      expectWorkspace(agentId, expectedWorkspace);
      if (testCase.fresh) {
        expect(auth?.nextConfig.agents.defaults).toMatchObject({ workspace: expectedWorkspace });
        const creationOrder = mocks.ensureOnboardingAgent.mock.invocationCallOrder[0]!;
        expect(mocks.applyAuthChoice.mock.invocationCallOrder[0]).toBeLessThan(creationOrder);
        expect(mocks.commitConfig.mock.invocationCallOrder[0]).toBeGreaterThan(creationOrder);
        expect(mocks.ensureOnboardingAgent).toHaveBeenCalledOnce();
        expect(mocks.ensureOnboardingAgent).toHaveBeenCalledWith(
          expect.objectContaining({
            firstAgent: { name: agentId },
            workspace: expectedWorkspace,
          }),
        );
        expect(mocks.ensureWorkspaceAndSessions.mock.calls.map(([dir]) => dir)).not.toContain(
          `${workspace}/main`,
        );
        if (testCase.legacyState) {
          expect(runtime.error).toHaveBeenCalledWith(
            expect.stringContaining("existing agents keep their current workspace"),
          );
        } else {
          expect(runtime.error).not.toHaveBeenCalled();
        }
      } else {
        const committed = mocks.commitConfig.mock.calls[0]?.[0].nextConfig.agents;
        expect(committed?.entries).toEqual(entries);
        expect(committed?.defaults).toMatchObject({ workspace });
        if (testCase.include) {
          expect(
            JSON.parse(await fs.readFile(path.join(configDir, "roster.json"), "utf8")),
          ).toEqual({ agents: { entries } });
        }
      }
    }),
  );

  it.each(
    [false, true].flatMap((existing) =>
      (["none", "during-auth", "after-creation"] as const).map((foreignWrite) => ({
        existing,
        foreignWrite,
      })),
    ),
  )(
    "guards the config revision across named creation: existing=$existing, foreign=$foreignWrite",
    async ({ existing, foreignWrite }) => {
      const { ensureOnboardingAgent } =
        await vi.importActual<typeof import("../onboard-agent.js")>("../onboard-agent.js");
      const { commitNonInteractiveOnboardConfig } =
        await vi.importActual<typeof import("./config-write.js")>("./config-write.js");
      return withTempHome(async (rawHome) => {
        const home = await fs.realpath(rawHome);
        const configDir = path.join(home, ".openclaw");
        const configPath = path.join(configDir, "openclaw.json");
        const workspace = path.join(home, "workspace");
        // Remove the helper's legacy main sessions to exercise first-install admission.
        await fs.rm(path.join(configDir, "agents"), { recursive: true });
        const initialConfig = {
          agents: { defaults: { model: { primary: "fixture/baseline" } } },
        };
        const initialRaw = existing ? JSON.stringify(initialConfig) : null;
        if (initialRaw) {
          await fs.writeFile(configPath, initialRaw);
        }
        resetConfigRuntimeState();
        const before = await readConfigFileSnapshot();
        expect(before).toMatchObject({ valid: true, exists: existing });
        let foreignRaw: string | undefined;
        const withModel = (config: OpenClawConfig, primary: string): OpenClawConfig => ({
          ...config,
          agents: {
            ...config.agents,
            defaults: { ...config.agents?.defaults, model: { primary } },
          },
        });
        const writeForeignConfig = async (config: OpenClawConfig) => {
          foreignRaw = JSON.stringify(withModel(config, "fixture/foreign"));
          await fs.writeFile(configPath, foreignRaw);
        };
        mocks.applyAuthChoice.mockImplementationOnce(async ({ nextConfig }) => {
          const currentRaw = existing ? await fs.readFile(configPath, "utf8") : null;
          expect(currentRaw).toBe(initialRaw);
          if (!existing) {
            await expect(fs.stat(configPath)).rejects.toMatchObject({ code: "ENOENT" });
          }
          if (foreignWrite === "during-auth") {
            await writeForeignConfig(existing ? initialConfig : {});
          }
          return withModel(nextConfig, "fixture/selected");
        });
        let creationHash: string | undefined;
        mocks.ensureOnboardingAgent.mockImplementationOnce(async (params) => {
          const created = await ensureOnboardingAgent(params);
          creationHash = created.configHash;
          if (foreignWrite === "after-creation") {
            await writeForeignConfig(JSON.parse(await fs.readFile(configPath, "utf8")));
          }
          return created;
        });
        mocks.commitConfig.mockImplementationOnce(commitNonInteractiveOnboardConfig);

        const outcome = await runSetup({
          agentName: "robby",
          workspace,
          authChoice: "demo-api-key",
          skipBootstrap: true,
          installDaemon: false,
          json: true,
        }).catch((error: unknown) => error);
        const persistedRaw = await fs.readFile(configPath, "utf8");
        if (foreignWrite !== "none") {
          expect.soft(persistedRaw).toBe(foreignRaw);
          expect(outcome).toBeInstanceOf(Error);
          expect((outcome as Error).message).toMatch(/config changed|base hash/i);
          expect(mocks.commitConfig).toHaveBeenCalledTimes(foreignWrite === "during-auth" ? 0 : 1);
          expect(mocks.logConfigUpdated).not.toHaveBeenCalled();
        } else {
          expect(outcome).toBeUndefined();
          expect(creationHash).toEqual(expect.any(String));
          expect(creationHash).not.toBe(before.hash);
          expect(mocks.commitConfig).toHaveBeenCalledWith(
            expect.objectContaining({ baseHash: creationHash }),
          );
          expect(JSON.parse(persistedRaw).agents).toMatchObject({
            defaults: { workspace, model: { primary: "fixture/selected" } },
            entries: { robby: { name: "robby", workspace } },
          });
          expect(Object.keys(JSON.parse(persistedRaw).agents.entries)).toEqual(["robby"]);
          expect(mocks.logConfigUpdated).toHaveBeenCalledOnce();
        }
      });
    },
  );

  it("does not publish config when the existing agent workspace cannot be provisioned", async () => {
    mocks.ensureWorkspaceAndSessions.mockRejectedValueOnce(new Error("workspace is unwritable"));

    await expect(
      runLocal({ authChoice: "skip" }, { agents: { entries: { ops: {} } } }),
    ).rejects.toThrow("workspace is unwritable");

    expect(mocks.commitConfig).not.toHaveBeenCalled();
    expect(mocks.logConfigUpdated).not.toHaveBeenCalled();
  });

  it("creates a role team through non-interactive onboarding and keeps coordinator ownership", async () => {
    const { ensureOnboardingAgent } =
      await vi.importActual<typeof import("../onboard-agent.js")>("../onboard-agent.js");
    const { commitNonInteractiveOnboardConfig } =
      await vi.importActual<typeof import("./config-write.js")>("./config-write.js");
    return withTempHome(async (rawHome) => {
      const home = await fs.realpath(rawHome);
      const configDir = path.join(home, ".openclaw");
      const workspace = path.join(home, "team-workspaces");
      await fs.rm(path.join(configDir, "agents"), { recursive: true });
      resetConfigRuntimeState();
      mocks.ensureOnboardingAgent.mockImplementationOnce(ensureOnboardingAgent);
      mocks.commitConfig.mockImplementationOnce(commitNonInteractiveOnboardConfig);

      await runSetup({ workspace, team: true, json: true });

      const after = await readConfigFileSnapshot();
      expect(after.valid).toBe(true);
      expect(Object.keys(after.config.agents?.entries ?? {})).toEqual([
        "coordinator",
        "researcher",
        "writer",
        "reviewer",
      ]);
      expect(after.config.agents?.defaults?.systemAgent?.agentId).toBe("coordinator");
      expect(after.config.agents?.entries?.coordinator).toMatchObject({
        workspace: path.join(workspace, "coordinator"),
        subagents: { allowAgents: ["researcher", "writer", "reviewer"], delegationMode: "prefer" },
      });
      await expect(
        fs.stat(path.join(workspace, "coordinator", "BOOTSTRAP.md")),
      ).rejects.toMatchObject({ code: "ENOENT" });
      expect(lastOutput()).toMatchObject({
        ok: true,
        workspace: path.join(workspace, "coordinator"),
      });
    });
  });
});
