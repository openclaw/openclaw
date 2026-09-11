import fs from "node:fs/promises";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { prepareProviderModelAccess } from "../commands/models/auth-model-policy.js";
import type { ModelsAuthLoginFlowOptions } from "../commands/models/auth.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  answerProviderLoginModelAccess,
  buildProviderLoginChoicesReply,
  cancelProviderLoginFlow,
  createProviderLoginFlowRegistry,
  offerProviderLoginModelAccess,
  decideProviderLoginSessionAdoption,
  prepareProviderChannelLogin,
  reserveProviderLoginFlow,
  runProviderChannelLoginFlow,
  type ProviderChannelLoginChoice,
} from "./provider-auth-login-flow-runtime.js";

const resolveChoice = vi.hoisted(() =>
  vi.fn<typeof import("../plugins/provider-login-options.js").resolveProviderChannelLoginChoice>(),
);
vi.mock("../plugins/provider-login-options.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/provider-login-options.js")>()),
  resolveProviderChannelLoginChoice: resolveChoice,
}));

const choice: ProviderChannelLoginChoice = {
  choiceId: "device",
  pluginId: "acme",
  providerId: "acme-cloud",
  methodId: "device-code",
  label: "Acme device login",
  providerLabel: "Acme",
  command: "acme/device",
  mode: "chat",
};
const loginParams = {
  choice,
  agentId: "main",
  config: {},
  runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
  sendMessage: vi.fn(async (_message: string) => {}),
  unsupportedPromptMessage: "Open Control UI to enter credentials.",
};

describe("provider channel login runtime", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveChoice.mockReturnValue({ status: "resolved", choice });
  });

  it("authorizes private cancellation and leaves other conversations active", async () => {
    const flows = createProviderLoginFlowRegistry();
    const first = reserveProviderLoginFlow({ flows, flowKey: "first" });
    const other = reserveProviderLoginFlow({ flows, flowKey: "other" });
    const params = {
      commandText: "/login cancel",
      commandAuthorized: true,
      senderIsOwner: true,
      isPrivateChat: true,
      config: { commands: { ownerAllowFrom: ["owner"] } },
      agentId: "main",
      cancelLogin: () => cancelProviderLoginFlow({ flows, flowKey: "first" }),
    };
    await prepareProviderChannelLogin({ ...params, senderIsOwner: false });
    await prepareProviderChannelLogin({ ...params, commandAuthorized: false });
    await prepareProviderChannelLogin({ ...params, isPrivateChat: false });
    expect(flows.size).toBe(2);
    expect(await prepareProviderChannelLogin(params)).toMatchObject({
      status: "reply",
      reply: { text: "Provider login cancelled for this chat." },
    });
    expect(first.status === "reserved" && first.record.signal.aborted).toBe(true);
    expect(other.status === "reserved" && other.record.signal.aborted).toBe(false);
    expect(await prepareProviderChannelLogin(params)).toMatchObject({
      status: "reply",
      reply: { text: "No provider login is active in this chat." },
    });
    cancelProviderLoginFlow({ flows, flowKey: "other" });
  });

  it.each([
    [
      "Show all Acme models",
      ["other/current", "acme-cloud/*"],
      "Application by the running Gateway is not confirmed.",
    ],
    ["Keep current restrictions", ["other/current"], "Current model restrictions kept."],
  ])("applies an authorized %s answer through the policy owner", async (label, allow, outcome) => {
    await withOpenClawTestState({ label: "channel-model-consent" }, async (state) => {
      const config: OpenClawConfig = {
        agents: {
          defaults: { model: "other/current", modelPolicy: { allow: ["other/current"] } },
          entries: { main: { workspace: state.workspaceDir } },
        },
      };
      await state.writeConfig(config);
      const prepared = prepareProviderModelAccess({
        config,
        agentId: "main",
        provider: "acme-cloud",
        providerLabel: "Acme",
      });
      if (!prepared) {
        throw new Error("Expected restricted-provider consent");
      }
      const flows = createProviderLoginFlowRegistry();
      const reservation = reserveProviderLoginFlow({ flows, flowKey: "private-owner" });
      if (reservation.status !== "reserved") {
        throw new Error("Expected a new login");
      }
      const reply = offerProviderLoginModelAccess({
        record: reservation.record,
        prepared,
        terminalMessage: "Credentials saved, but the Gateway could not apply the auth update.",
      });
      const button = reply.presentation?.blocks
        .flatMap((block) => (block.type === "buttons" ? block.buttons : []))
        .find((entry) => entry.label === label);
      if (button?.action?.type !== "command") {
        throw new Error("Expected a model access command");
      }
      const request = {
        flows,
        flowKey: "private-owner",
        command: button.action.command,
        runtime: loginParams.runtime,
      };
      await expect(
        answerProviderLoginModelAccess({
          ...request,
          assertCurrent: () => {
            throw new Error("Owner revoked");
          },
        }),
      ).rejects.toThrow("Owner revoked");
      expect(await fs.readFile(state.configPath, "utf8")).not.toContain("acme-cloud/*");
      const result = await answerProviderLoginModelAccess({ ...request, assertCurrent: () => {} });
      expect(result?.text).toContain(outcome);
      expect(result?.text).toContain("Gateway could not apply the auth update");
      const saved: OpenClawConfig = JSON.parse(await fs.readFile(state.configPath, "utf8"));
      expect(saved.agents?.defaults?.modelPolicy?.allow).toEqual(allow);
      expect(saved.agents?.defaults?.model).toBe("other/current");
      expect(flows.size).toBe(0);
      expect(
        await answerProviderLoginModelAccess({ ...request, assertCurrent: () => {} }),
      ).toBeUndefined();
    });
  });

  it("uses the host config replaced before flow entry", async () => {
    const config: OpenClawConfig = { plugins: { entries: { acme: { enabled: true } } } };
    let currentConfig = config;
    const readConfig = () => currentConfig;
    currentConfig = { plugins: { entries: { acme: { enabled: false } } } };
    resolveChoice.mockImplementation((_input, params) =>
      params?.config?.plugins?.entries?.acme?.enabled === false
        ? { status: "unsupported", choices: [] }
        : { status: "resolved", choice },
    );
    const runLoginFlow = vi.fn(async () => ({
      providerId: "acme-cloud",
      methodId: "device-code",
      authRefresh: "refreshed",
      profiles: [{ profileId: "acme-cloud:new", provider: "acme-cloud", mode: "oauth" }],
    }));

    await expect(
      runProviderChannelLoginFlow({ ...loginParams, config, readConfig, runLoginFlow }),
    ).rejects.toThrow("no longer available");
    expect(runLoginFlow).not.toHaveBeenCalled();
  });

  it.each(["write", "url", "device-code"] as const)(
    "rejects a disabled provider at the retained %s checkpoint",
    async (checkpoint) => {
      const config: OpenClawConfig = { plugins: { entries: { acme: { enabled: true } } } };
      let currentConfig = config;
      resolveChoice.mockImplementation((_input, params) =>
        params?.config?.plugins?.entries?.acme?.enabled === false
          ? { status: "unsupported", choices: [] }
          : { status: "resolved", choice },
      );
      const persist = vi.fn();
      const sendDeviceCode = vi.fn();
      const runLoginFlow = async (opts: ModelsAuthLoginFlowOptions) => {
        await Promise.resolve();
        currentConfig = { plugins: { entries: { acme: { enabled: false } } } };
        if (checkpoint === "write") {
          opts.assertCurrent?.();
          persist();
        } else if (checkpoint === "url") {
          await opts.openUrl?.("https://example.com/login");
        } else {
          await opts.prompter.deviceCode?.({ title: "Sign in", code: "ABCD-EFGH" });
        }
        return {
          providerId: "acme-cloud",
          methodId: "device-code",
          authRefresh: "refreshed",
          profiles: [{ profileId: "acme-cloud:new", provider: "acme-cloud", mode: "oauth" }],
        };
      };
      await expect(
        runProviderChannelLoginFlow({
          ...loginParams,
          config,
          readConfig: () => currentConfig,
          runLoginFlow,
          sendDeviceCode,
        }),
      ).rejects.toThrow("no longer available");
      expect(persist).not.toHaveBeenCalled();
      expect(loginParams.sendMessage).not.toHaveBeenCalled();
      expect(sendDeviceCode).not.toHaveBeenCalled();
    },
  );

  it("checks live caller authority before saving credentials", async () => {
    const config: OpenClawConfig = { commands: { ownerAllowFrom: ["owner"] } };
    let currentConfig = config;
    const persist = vi.fn();
    const runLoginFlow = async (opts: ModelsAuthLoginFlowOptions) => {
      await Promise.resolve();
      currentConfig = { commands: { ownerAllowFrom: ["replacement"] } };
      opts.assertCurrent?.();
      persist();
      return {
        providerId: "acme-cloud",
        methodId: "device-code",
        authRefresh: "refreshed",
        profiles: [{ profileId: "acme-cloud:new", provider: "acme-cloud", mode: "oauth" }],
      };
    };
    await expect(
      runProviderChannelLoginFlow({
        ...loginParams,
        config,
        readConfig: () => currentConfig,
        runLoginFlow,
        assertCurrent: (current) => {
          if (!current.commands?.ownerAllowFrom?.includes("owner")) {
            throw new Error("Caller no longer owns this login.");
          }
        },
      }),
    ).rejects.toThrow("Caller no longer owns this login");
    expect(persist).not.toHaveBeenCalled();
  });

  it("preserves the saved result when caller authority changes after persistence", async () => {
    let authorized = true;
    const result = await runProviderChannelLoginFlow({
      ...loginParams,
      assertCurrent: () => {
        if (!authorized) {
          throw new Error("Caller no longer owns this login.");
        }
      },
      runLoginFlow: async (opts) => {
        opts.assertCurrent?.();
        const saved = {
          providerId: "acme-cloud",
          methodId: "device-code",
          authRefresh: "refreshed",
          profiles: [{ profileId: "acme-cloud:saved", provider: "acme-cloud", mode: "oauth" }],
        };
        authorized = false;
        return saved;
      },
    });
    expect(result.profiles).toEqual([
      { profileId: "acme-cloud:saved", provider: "acme-cloud", mode: "oauth" },
    ]);
    expect(loginParams.sendMessage).not.toHaveBeenCalled();
  });

  it("preserves a personal account selected after login started", () => {
    expect(
      decideProviderLoginSessionAdoption({
        currentModelProvider: "acme-cloud",
        loginProvider: "acme-cloud",
        nextProfileId: "acme-cloud:new",
        snapshot: undefined,
        current: {
          sessionId: "created-during-login",
          modelProvider: "acme-cloud",
          authProfileOverride: "acme-cloud:personal",
          authProfileOverrideSource: "user-link",
        },
      }),
    ).toEqual({ status: "rejected" });
  });

  it.each(["removed", "pluginId", "providerId", "methodId"] as const)(
    "rejects a stale %s before the provider can start",
    async (field) => {
      resolveChoice.mockReturnValue(
        field === "removed"
          ? { status: "unsupported", choices: [] }
          : { status: "resolved", choice: { ...choice, [field]: "replacement" } },
      );
      const runLoginFlow = vi.fn();
      await expect(runProviderChannelLoginFlow({ ...loginParams, runLoginFlow })).rejects.toThrow(
        "no longer available",
      );
      expect(runLoginFlow).not.toHaveBeenCalled();
    },
  );

  it("passes the selected owner and forbids chat credential input", async () => {
    const runLoginFlow = vi.fn(async (opts: ModelsAuthLoginFlowOptions) => {
      await opts.prompter.text({ message: "Enter your API key" });
    });
    await expect(runProviderChannelLoginFlow({ ...loginParams, runLoginFlow })).rejects.toThrow(
      "Open Control UI",
    );
    expect(runLoginFlow).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerPluginId: "acme",
        provider: "acme-cloud",
        method: "device-code",
        credentialOnly: true,
      }),
    );
    expect(loginParams.sendMessage).toHaveBeenCalledExactlyOnceWith(
      "Open Control UI to enter credentials.",
    );
  });

  it("keeps every provider button and its text fallback bound to the same command", () => {
    const providers = Array.from({ length: 12 }, (_, index) => ({
      pluginId: `plugin-${index}`,
      providerId: `provider-${index}`,
      label: `Provider ${index}`,
    }));
    const reply = buildProviderLoginChoicesReply({ status: "providers", providers });
    const buttons = reply.presentation?.blocks.flatMap((block) =>
      block.type === "buttons" ? block.buttons : [],
    );
    expect(buttons).toHaveLength(12);
    for (const button of buttons ?? []) {
      expect(button.action?.type).toBe("command");
      if (button.action?.type === "command") {
        expect(reply.text).toContain(`${button.label}: \`${button.action.command}\``);
      }
    }
    expect(reply.text).toContain("/login oauth/plugin-11/provider-11");
  });
});
