import fs from "node:fs/promises";
import { setImmediate as nextEventLoopTurn } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import type { ModelsAuthLoginFlowOptions } from "../../commands/models/auth.js";
import type { RuntimeConfigWriteApplicationClaim } from "../../config/runtime-write-application.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createDeferredCore } from "../../shared/deferred.js";
import type { ReplyPayload } from "../types.js";
import {
  blockReplyOpts,
  buildLoginParams,
  dispatchLoginCommand,
  runModelsAuthLoginFlowMock,
  setupLoginCommandTests,
} from "./commands-login.harness-test-support.js";

const refreshAuthRuntime = vi.hoisted(() => vi.fn<() => Promise<void>>());
vi.mock("../../gateway/model-auth-refresh.js", () => ({
  refreshModelAuthStateAfterMutation: refreshAuthRuntime,
}));

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

function loginChoiceCommand(
  reply: ReplyPayload | undefined,
  label = "Show all OpenAI models",
): string {
  const button = reply?.presentation?.blocks
    .flatMap((block) => (block.type === "buttons" ? block.buttons : []))
    .find((entry) => entry.label === label);
  if (button?.action?.type !== "command") {
    throw new Error(`Expected ${label} in the login choices.`);
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

  it.each([
    { provider: "refresh", label: "Refresh" },
    { provider: "access", label: "Access" },
  ])(
    "dispatches the manifest menu for $provider without shadowing reserved commands",
    async ({ provider, label }) => {
      await withOpenClawTestState({ label: "login-reserved-provider" }, async (state) => {
        const pluginId = "reserved-login";
        const pluginFile = await state.writeText(
          `${pluginId}/index.cjs`,
          "module.exports = { register() {} };\n",
        );
        await state.writeJson(`${pluginId}/openclaw.plugin.json`, {
          id: pluginId,
          configSchema: { type: "object", additionalProperties: false, properties: {} },
          providers: ["refresh", "access"],
          providerAuthChoices: ["refresh", "access"].flatMap((id) =>
            ["device-code", "oauth"].map((method) => ({
              provider: id,
              method,
              choiceId: method === "device-code" ? id : `${id}-browser`,
              choiceLabel: `${id} ${method}`,
              groupId: id,
              groupLabel: id === "refresh" ? "Refresh" : "Access",
              appGuidedAuth: method,
              credentialOnly: true,
              channelLogin: {},
            })),
          ),
        });
        const config: OpenClawConfig = {
          ...buildLoginParams("/login").cfg,
          plugins: {
            allow: [pluginId],
            load: { paths: [pluginFile] },
            entries: { [pluginId]: { enabled: true } },
          },
        };
        await state.writeConfig(config);
        const before = await fs.readFile(state.configPath, "utf8");
        const delivery = blockReplyOpts();
        const command = (body: string) => {
          const params = buildLoginParams(body, {
            opts: { ...delivery, getProviderLoginConfig: () => config },
          });
          params.cfg = config;
          return dispatchLoginCommand(params);
        };
        const menu = await command("/login");
        const providerCommand = loginChoiceCommand(menu.reply, label);
        expect(providerCommand).toBe(`/login oauth/${pluginId}/${provider}`);
        const methods = await command(providerCommand);
        const methodCommand = loginChoiceCommand(methods.reply, `${provider} device-code`);
        expect(methodCommand).toBe(`/login ${pluginId}/${provider}`);
        expect(runModelsAuthLoginFlowMock).not.toHaveBeenCalled();
        runModelsAuthLoginFlowMock.mockImplementationOnce(
          async (opts: ModelsAuthLoginFlowOptions) => {
            await opts.prompter.note(`Continue with the ${provider} provider.`);
            return {
              providerId: provider,
              methodId: "device-code",
              authRefresh: "refreshed",
              profiles: [{ profileId: `${provider}:owner`, provider, mode: "oauth" }],
            };
          },
        );
        const completed = await command(methodCommand);
        expect(runModelsAuthLoginFlowMock).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({ ownerPluginId: pluginId, provider, method: "device-code" }),
        );
        expect(delivery.onBlockReply).toHaveBeenCalledWith({
          text: `Continue with the ${provider} provider.`,
        });
        expect(completed.reply?.text).toBe(`${label} login complete. Try your request again now.`);

        const refreshed = await command("/login refresh");
        expect(refreshed.reply?.text).toBe(
          "Sign-in status refreshed. Send /models to see available models.",
        );
        expect(refreshAuthRuntime).toHaveBeenCalledOnce();
        const access = await command("/login access");
        expect(access.reply?.text).toBe(
          "This model access choice is no longer available. Open Models to change which models are allowed.",
        );
        expect(runModelsAuthLoginFlowMock).toHaveBeenCalledOnce();
        expect(await fs.readFile(state.configPath, "utf8")).toBe(before);
      });
    },
  );

  it.each(["applied", "failed", "restart-pending"] as const)(
    "waits for registered model-access application and reports %s",
    async (status) => {
      await withOpenClawTestState({ label: "login-access-application" }, async (state) => {
        const config: OpenClawConfig = {
          ...buildLoginParams("/login openai").cfg,
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
          return dispatchLoginCommand(params);
        };
        const initial = await command("/login openai");
        const claimReady = createDeferredCore<RuntimeConfigWriteApplicationClaim>();
        let pendingClaim: RuntimeConfigWriteApplicationClaim | undefined;
        const stop = registerRuntimeConfigWriteListener((event) => {
          const claim = getRuntimeConfigWriteApplication(event)?.claim();
          if (claim) {
            pendingClaim = claim;
            claimReady.resolve(claim);
          }
        });
        const response = command(loginChoiceCommand(initial.reply));
        try {
          const claim = await Promise.race([
            claimReady.promise,
            response.then(() => {
              throw new Error("Model-access command completed without an application receipt.");
            }),
          ]);
          expect(
            await Promise.race([response.then(() => "completed"), nextEventLoopTurn("pending")]),
          ).toBe("pending");
          claim.settle(status);
          const result = await response;
          const saved: OpenClawConfig = JSON.parse(await fs.readFile(state.configPath, "utf8"));
          expect(saved.agents?.defaults?.modelPolicy?.allow).toEqual(["other/current", "openai/*"]);
          expect(saved.agents?.defaults?.model).toBe("other/current");
          expect(result.reply?.text).toContain(
            status === "applied"
              ? "All OpenAI models are now visible."
              : "Model access was saved, but OpenClaw has not confirmed it is active. Open Settings and select Apply changes, then send /models.",
          );
          expect(result.reply?.presentation).toBeUndefined();
          expect(runModelsAuthLoginFlowMock).toHaveBeenCalledOnce();
        } finally {
          pendingClaim?.settle("failed");
          stop();
          await response;
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
        let authorized = true;
        const command = async (body: string) => {
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
        const oldChoice = loginChoiceCommand(initial?.reply);
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
          authorized = false;
          await expect(command(oldChoice)).rejects.toThrow("Owner access was removed.");
          expect(await fs.readFile(state.configPath, "utf8")).toBe(before);
          authorized = true;
          const recovered = await command(oldChoice);
          const freshChoice = loginChoiceCommand(recovered?.reply);
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
          authorized = true;
          await command("/login cancel");
        }
      });
    },
  );

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
      const choice = loginChoiceCommand(initial?.reply);
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
              authRefresh: "gateway-rejected",
              profiles: [{ profileId: "openai:new", provider: "openai", mode: "oauth" }],
            };
          },
        );
        const login = await dispatchLoginCommand(params);
        expect(login?.shouldContinue).toBe(false);
        expect(login.reply?.text).toContain("Sign-in status could not be confirmed.");
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
        const beforeDenied = await fs.readFile(state.configPath, "utf8");
        const wrongSession = await dispatchLoginCommand(
          buildLoginParams(command, { sessionKey: "agent:main:other" }),
        );
        expect(loginChoiceCommand(wrongSession?.reply)).not.toBe(command);
        const denied = await dispatchLoginCommand(
          buildLoginParams(command, { command: { senderIsOwner: false } }),
        );
        expect(denied?.reply?.text).toContain("Only an OpenClaw owner can sign in here.");
        setRuntimeConfigSnapshot(revokedConfig);
        await expect(dispatchLoginCommand(buildLoginParams(command))).rejects.toThrow(
          "Provider login authority is no longer active.",
        );
        expect(await fs.readFile(state.configPath, "utf8")).toBe(beforeDenied);
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
          await expect(dispatchLoginCommand(buildLoginParams(command))).rejects.toThrow(outcome);
        } else {
          const result = await dispatchLoginCommand(buildLoginParams(command));
          expect(result?.reply?.text).toContain(outcome);
          if (revocation === "authorized") {
            expect(result.reply?.text).not.toContain("Sign-in status could not be confirmed.");
            expect(result.reply?.text).toContain(
              "To update saved sign-in status, send /login refresh.",
            );
            expect(result.reply?.presentation).toBeUndefined();
            const cancelled = await dispatchLoginCommand(buildLoginParams("/login cancel"));
            expect(cancelled.reply?.text).toBe("No provider login is active in this chat.");
          }
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
          await expect(dispatchLoginCommand(buildLoginParams(command))).rejects.toThrow(
            "Provider login authority is no longer active.",
          );
        } else {
          const replay = await dispatchLoginCommand(buildLoginParams(command));
          if (revocation === "authorized") {
            expect(loginChoiceCommand(replay.reply)).not.toBe(command);
          }
        }
        expect(await fs.readFile(state.configPath, "utf8")).toBe(beforeReplay);
        expect(runModelsAuthLoginFlowMock).toHaveBeenCalledOnce();
      });
    },
  );
});
