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
    { saved: "bun", requested: "pnpm", expected: "pnpm", skipSkills: false },
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
          const payload = lastOutput();
          expect(payload).toEqual({
            ok: false,
            error: { type: "cli_error", message: payload.message },
            phase: "options",
            message: expect.stringContaining("Multiple API key flags were provided"),
          });
          expect(payload.message).toContain("--openai-api-key, --anthropic-api-key");
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

  it.each(
    [false, true].flatMap((existing) =>
      (["none", "during-auth", "after-creation"] as const).map((foreignWrite) => ({
        existing,
        foreignWrite,
      })),
    ),
  )(
    "guards first-agent ownership and config revision: existing=$existing, foreign=$foreignWrite",
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
        const agentId = existing ? "robby" : "main";
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
        mocks.applyAuthChoice.mockImplementationOnce(async ({ nextConfig, target }) => {
          expect(target).toEqual({
            agentId,
            agentDir: path.join(configDir, "agents", agentId, "agent"),
            workspaceDir: workspace,
          });
          expect(nextConfig.agents.defaults.workspace).toBe(workspace);
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
        mocks.ensureOnboardingAgent.mockImplementationOnce(async (params) => {
          const created = await ensureOnboardingAgent(params);
          if (foreignWrite === "after-creation") {
            await writeForeignConfig(JSON.parse(await fs.readFile(configPath, "utf8")));
          }
          return created;
        });
        mocks.commitConfig.mockImplementationOnce(commitNonInteractiveOnboardConfig);

        const outcome = await runSetup({
          agentName: existing ? agentId : undefined,
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
          expect(mocks.logConfigUpdated).not.toHaveBeenCalled();
        } else {
          expect(outcome).toBeUndefined();
          expectWorkspace(agentId, workspace);
          const creationOrder = mocks.ensureOnboardingAgent.mock.invocationCallOrder[0]!;
          expect(mocks.applyAuthChoice.mock.invocationCallOrder[0]).toBeLessThan(creationOrder);
          expect(mocks.commitConfig.mock.invocationCallOrder[0]).toBeGreaterThan(creationOrder);
          expect(runtime.error).not.toHaveBeenCalled();
          expect(JSON.parse(persistedRaw).agents).toMatchObject({
            defaults: { workspace, model: { primary: "fixture/selected" } },
            entries: { [agentId]: { name: agentId, workspace } },
          });
          expect(Object.keys(JSON.parse(persistedRaw).agents.entries)).toEqual([agentId]);
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
