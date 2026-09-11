import fs from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import type { ModelsAuthLoginFlowOptions } from "../../commands/models/auth.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { ReplyPayload } from "../types.js";
import {
  blockReplyOpts,
  buildLoginParams,
  runModelsAuthLoginFlowMock,
  setupLoginCommandTests,
} from "./commands-login.harness-test-support.js";

const { handleLoginCommand } = await import("./commands-login.js");
const { prepareProviderModelAccess } = await import("../../commands/models/auth-model-policy.js");
const {
  getRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
  setRuntimeConfigSnapshotRefreshHandler,
  registerRuntimeConfigWriteListener,
} = await import("../../config/runtime-snapshot.js");
const { getRuntimeConfigWriteApplication } =
  await import("../../config/runtime-write-application.js");
const { withOpenClawTestState } = await import("../../test-utils/openclaw-test-state.js");

function modelAccessCommand(reply: ReplyPayload | undefined): string {
  const button = reply?.presentation?.blocks
    .flatMap((block) => (block.type === "buttons" ? block.buttons : []))
    .find((entry) => entry.label === "Show all OpenAI models");
  if (button?.action?.type !== "command") {
    throw new Error("Expected a model-access choice in the reply.");
  }
  return button.action.command;
}

function mockSuccessfulLoginWithRestrictions(config: OpenClawConfig): void {
  runModelsAuthLoginFlowMock.mockImplementation(async (opts: ModelsAuthLoginFlowOptions) => {
    const prepared = prepareProviderModelAccess({
      config,
      agentId: "main",
      provider: "openai",
      providerLabel: "OpenAI",
    });
    if (!prepared || !opts.onModelAccessRequested) {
      throw new Error("Expected a restricted-provider login.");
    }
    opts.onModelAccessRequested(prepared);
    return {
      providerId: "openai",
      methodId: "device-code",
      authRefresh: "refreshed",
      profiles: [{ profileId: "openai:owner", provider: "openai", mode: "oauth" }],
    };
  });
}

describe("handleLoginCommand model consent", () => {
  setupLoginCommandTests();

  it.each(["failed", "restart-pending"] as const)(
    "reports saved model access when application is %s",
    async (status) => {
      await withOpenClawTestState({ label: "login-access-application" }, async (state) => {
        const config: OpenClawConfig = {
          ...buildLoginParams("/login codex").cfg,
          agents: {
            defaults: { model: "other/current", modelPolicy: { allow: ["other/current"] } },
            entries: { main: { workspace: state.workspaceDir } },
          },
        };
        await state.writeConfig(config);
        mockSuccessfulLoginWithRestrictions(config);
        const command = (body: string) => {
          const params = buildLoginParams(body, {
            opts: { ...blockReplyOpts(), getProviderLoginConfig: () => config },
          });
          params.cfg = config;
          return handleLoginCommand(params, true);
        };
        const initial = await command("/login codex");
        const stop = registerRuntimeConfigWriteListener((event) => {
          getRuntimeConfigWriteApplication(event)?.claim()?.settle(status);
        });
        try {
          const result = await command(modelAccessCommand(initial?.reply));
          const saved: OpenClawConfig = JSON.parse(await fs.readFile(state.configPath, "utf8"));
          expect(saved.agents?.defaults?.modelPolicy?.allow).toEqual(["other/current", "openai/*"]);
          expect(result?.reply?.text).toContain(
            "Model access was saved, but OpenClaw has not confirmed it is active. Open Settings and select Apply changes, then send /models.",
          );
          expect(result?.reply?.presentation).toBeUndefined();
          expect(runModelsAuthLoginFlowMock).toHaveBeenCalledOnce();
        } finally {
          stop();
        }
      });
    },
  );

  it.each(["expired", "changed", "cancelled"] as const)(
    "renews a %s model-access choice without another sign-in or an unconfirmed write",
    async (cause) => {
      await withOpenClawTestState({ label: "login-access-recovery" }, async (state) => {
        let config: OpenClawConfig = {
          ...buildLoginParams("/login codex").cfg,
          agents: {
            defaults: { model: "other/current", modelPolicy: { allow: ["other/current"] } },
            entries: { main: { workspace: state.workspaceDir } },
          },
        };
        await state.writeConfig(config);
        mockSuccessfulLoginWithRestrictions(config);
        const command = async (body: string) => {
          const params = buildLoginParams(body, {
            opts: { ...blockReplyOpts(), getProviderLoginConfig: () => config },
          });
          params.cfg = config;
          return handleLoginCommand(params, true);
        };
        const initial = await command("/login codex");
        const oldChoice = modelAccessCommand(initial?.reply);
        const now = vi.spyOn(Date, "now");
        const stop = registerRuntimeConfigWriteListener((event) => {
          getRuntimeConfigWriteApplication(event)?.claim()?.settle("applied");
        });
        try {
          if (cause === "expired") {
            now.mockReturnValue(Date.now() + 15 * 60_000 + 1);
          } else if (cause === "changed") {
            config = {
              ...config,
              agents: {
                ...config.agents,
                defaults: {
                  ...config.agents?.defaults,
                  modelPolicy: { allow: ["other/replacement"] },
                },
              },
            };
            await state.writeConfig(config);
          } else {
            await command("/login cancel");
          }
          const before = await fs.readFile(state.configPath, "utf8");
          const recovered = await command(oldChoice);
          const freshChoice = modelAccessCommand(recovered?.reply);
          expect(freshChoice).not.toBe(oldChoice);
          expect(await fs.readFile(state.configPath, "utf8")).toBe(before);
          expect(runModelsAuthLoginFlowMock).toHaveBeenCalledOnce();

          const completed = await command(freshChoice);
          expect(completed?.reply?.text).toBe(
            "All OpenAI models are now visible.\n\nSend /models to choose a model. To update saved sign-in status, send /login refresh.",
          );
          const saved: OpenClawConfig = JSON.parse(await fs.readFile(state.configPath, "utf8"));
          expect(saved.agents?.defaults?.modelPolicy?.allow).toEqual(
            cause === "changed" ? ["other/replacement", "openai/*"] : ["other/current", "openai/*"],
          );
          expect(saved.agents?.defaults?.model).toBe("other/current");
          expect(runModelsAuthLoginFlowMock).toHaveBeenCalledOnce();
        } finally {
          stop();
          now.mockRestore();
          await command("/login cancel");
        }
      });
    },
  );

  it("checks current authority before renewing an old model-access question", async () => {
    await withOpenClawTestState({ label: "login-access-authority" }, async (state) => {
      const config: OpenClawConfig = {
        ...buildLoginParams("/login codex").cfg,
        agents: {
          defaults: { model: "other/current", modelPolicy: { allow: ["other/current"] } },
          entries: { main: { workspace: state.workspaceDir } },
        },
      };
      await state.writeConfig(config);
      mockSuccessfulLoginWithRestrictions(config);
      let authorized = true;
      const command = (body: string) => {
        const params = buildLoginParams(body, {
          opts: {
            ...blockReplyOpts(),
            getProviderLoginConfig: () => config,
            assertProviderLoginAuthority: () => {
              if (!authorized) {
                throw new Error("Owner access was removed.");
              }
            },
          },
        });
        params.cfg = config;
        return handleLoginCommand(params, true);
      };
      const initial = await command("/login codex");
      const oldChoice = modelAccessCommand(initial?.reply);
      await command("/login cancel");
      const before = await fs.readFile(state.configPath, "utf8");
      authorized = false;
      await expect(command(oldChoice)).rejects.toThrow("Owner access was removed.");
      expect(await fs.readFile(state.configPath, "utf8")).toBe(before);
      authorized = true;
      try {
        const recovered = await command(oldChoice);
        expect(modelAccessCommand(recovered?.reply)).not.toBe(oldChoice);
        expect(await fs.readFile(state.configPath, "utf8")).toBe(before);
        expect(runModelsAuthLoginFlowMock).toHaveBeenCalledOnce();
      } finally {
        await command("/login cancel");
      }
    });
  });

  it("keeps model access answerable after releasing the login reservation", async () => {
    await withOpenClawTestState({ label: "login-access-lifetime" }, async (state) => {
      const config: OpenClawConfig = {
        ...buildLoginParams("/login codex").cfg,
        agents: {
          defaults: { model: "other/current", modelPolicy: { allow: ["other/current"] } },
          entries: { main: { workspace: state.workspaceDir } },
        },
      };
      await state.writeConfig(config);
      mockSuccessfulLoginWithRestrictions(config);
      const command = (body: string) => {
        const params = buildLoginParams(body, {
          opts: { ...blockReplyOpts(), getProviderLoginConfig: () => config },
        });
        params.cfg = config;
        return handleLoginCommand(params, true);
      };
      const initial = await command("/login codex");
      const choice = modelAccessCommand(initial?.reply);
      runModelsAuthLoginFlowMock.mockResolvedValueOnce({
        providerId: "openrouter",
        methodId: "oauth",
        authRefresh: "refreshed",
        profiles: [{ profileId: "openrouter:default", provider: "openrouter", mode: "api_key" }],
      });
      const another = await command("/login openrouter/openrouter-oauth");
      expect(another?.reply?.text).toContain("OpenRouter login complete");
      expect(runModelsAuthLoginFlowMock).toHaveBeenCalledTimes(2);
      await command(choice);
      const saved: OpenClawConfig = JSON.parse(await fs.readFile(state.configPath, "utf8"));
      expect(saved.agents?.defaults?.modelPolicy?.allow).toEqual(["other/current", "openai/*"]);
      expect(saved.agents?.defaults?.model).toBe("other/current");
    });
  });

  it.each([
    [
      "Show all OpenAI models",
      ["other/current", "openai/*"],
      "Application by the running Gateway is not confirmed.",
      "authorized",
    ],
    [
      "Keep current restrictions",
      ["other/current"],
      "Current model restrictions kept.",
      "authorized",
    ],
    [
      "Show all OpenAI models",
      ["other/current"],
      "Your model-access choice could not be applied.",
      "before-read",
    ],
    [
      "Show all OpenAI models",
      ["other/current"],
      "Provider login authority is no longer active.",
      "preflight",
    ],
    [
      "Show all OpenAI models",
      ["other/current"],
      "Provider login authority is no longer active.",
      "runtime-preflight",
    ],
  ])(
    "finishes login before applying %s with %s policy (%s; %s)",
    async (label, allow, outcome, revocation) => {
      await withOpenClawTestState({ label: "login-command-consent" }, async (state) => {
        const params = buildLoginParams("/login codex", { opts: blockReplyOpts() });
        params.cfg.agents = {
          defaults: { model: "other/current", modelPolicy: { allow: ["other/current"] } },
          entries: { main: { workspace: state.workspaceDir } },
        };
        params.cfg.commands = { ...params.cfg.commands, allowFrom: { slack: ["owner"] } };
        await state.writeConfig(params.cfg);
        setRuntimeConfigSnapshot(params.cfg);
        const prepared = prepareProviderModelAccess({
          config: params.cfg,
          agentId: "main",
          provider: "openai",
          providerLabel: "OpenAI",
        });
        if (!prepared) {
          throw new Error("Expected restricted-provider consent");
        }
        runModelsAuthLoginFlowMock.mockImplementationOnce(
          async (opts: ModelsAuthLoginFlowOptions) => {
            opts.onModelAccessRequested?.(prepared);
            return {
              providerId: "openai",
              methodId: "device-code",
              authRefresh: "refreshed",
              profiles: [{ profileId: "openai:new", provider: "openai", mode: "oauth" }],
            };
          },
        );
        const login = await handleLoginCommand(params, true);
        expect(login?.shouldContinue).toBe(false);
        const button = login?.reply?.presentation?.blocks
          .flatMap((block) => (block.type === "buttons" ? block.buttons : []))
          .find((entry) => entry.label === label);
        if (button?.action?.type !== "command") {
          throw new Error("Expected returned consent buttons");
        }
        const command = button.action.command;
        const revokedConfig: OpenClawConfig = {
          ...params.cfg,
          commands: { ...params.cfg.commands, allowFrom: { slack: ["replacement"] } },
        };
        const wrongSession = await handleLoginCommand(
          buildLoginParams(command, { sessionKey: "agent:main:other" }),
          true,
        );
        expect(modelAccessCommand(wrongSession?.reply)).not.toBe(command);
        const denied = await handleLoginCommand(
          buildLoginParams(command, { command: { senderIsOwner: false } }),
          true,
        );
        expect(denied?.reply?.text).toContain("Only an OpenClaw owner can sign in here.");
        setRuntimeConfigSnapshot(revokedConfig);
        await expect(handleLoginCommand(buildLoginParams(command), true)).rejects.toThrow(
          "Provider login authority is no longer active.",
        );
        setRuntimeConfigSnapshot(params.cfg);
        const unchanged: OpenClawConfig = JSON.parse(await fs.readFile(state.configPath, "utf8"));
        expect(unchanged.agents?.defaults?.modelPolicy?.allow).toEqual(["other/current"]);
        if (revocation === "before-read") {
          await fs.writeFile(state.configPath, JSON.stringify(revokedConfig));
        } else {
          setRuntimeConfigSnapshotRefreshHandler({
            preflight: async () => {
              await Promise.resolve();
              if (revocation === "preflight") {
                await fs.writeFile(state.configPath, JSON.stringify(revokedConfig));
              }
              if (revocation === "preflight" || revocation === "runtime-preflight") {
                setRuntimeConfigSnapshot(revokedConfig);
              }
            },
            refresh: () => true,
          });
        }
        if (revocation === "preflight" || revocation === "runtime-preflight") {
          await expect(handleLoginCommand(buildLoginParams(command), true)).rejects.toThrow(
            outcome,
          );
        } else {
          const result = await handleLoginCommand(buildLoginParams(command), true);
          expect(result?.reply?.text).toContain(outcome);
        }
        const saved: OpenClawConfig = JSON.parse(await fs.readFile(state.configPath, "utf8"));
        expect(saved.agents?.defaults?.modelPolicy?.allow).toEqual(allow);
        expect(saved.agents?.defaults?.model).toBe("other/current");
        expect(saved.commands?.ownerAllowFrom).toEqual(["owner"]);
        expect(saved.commands?.allowFrom).toEqual({
          slack: [
            revocation === "authorized" || revocation === "runtime-preflight"
              ? "owner"
              : "replacement",
          ],
        });
        if (revocation === "runtime-preflight") {
          expect(getRuntimeConfigSnapshot()?.commands).toMatchObject({
            ownerAllowFrom: ["owner"],
            allowFrom: { slack: ["replacement"] },
          });
          expect(getRuntimeConfigSnapshot()?.agents?.defaults?.modelPolicy?.allow).toEqual([
            "other/current",
          ]);
        }
        const beforeReplay = await fs.readFile(state.configPath, "utf8");
        if (revocation === "preflight" || revocation === "runtime-preflight") {
          await expect(handleLoginCommand(buildLoginParams(command), true)).rejects.toThrow(
            "Provider login authority is no longer active.",
          );
        } else {
          await handleLoginCommand(buildLoginParams(command), true);
        }
        expect(await fs.readFile(state.configPath, "utf8")).toBe(beforeReplay);
        expect(runModelsAuthLoginFlowMock).toHaveBeenCalledOnce();
      });
    },
  );
});
