import fs from "node:fs/promises";
import { describe, expect, it } from "vitest";
import type { ModelsAuthLoginFlowOptions } from "../../commands/models/auth.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
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
} = await import("../../config/runtime-snapshot.js");
const { withOpenClawTestState } = await import("../../test-utils/openclaw-test-state.js");

describe("handleLoginCommand model consent", () => {
  setupLoginCommandTests();

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
      "Provider login authority is no longer active.",
      "before-read",
    ],
    [
      "Show all OpenAI models",
      ["other/current"],
      "Model access could not be updated: config changed since last load",
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
        expect(wrongSession?.reply?.text).toContain("no longer available");
        const denied = await handleLoginCommand(
          buildLoginParams(command, { command: { senderIsOwner: false } }),
          true,
        );
        expect(denied?.reply?.text).toContain("Only a configured OpenClaw owner/admin");
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
        const result = await handleLoginCommand(buildLoginParams(command), true);
        expect(result?.reply?.text).toContain(outcome);
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
        const duplicate = await handleLoginCommand(buildLoginParams(command), true);
        expect(duplicate?.reply?.text).toContain("no longer available");
        expect(runModelsAuthLoginFlowMock).toHaveBeenCalledOnce();
      });
    },
  );
});
