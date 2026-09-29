import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelsAuthLoginFlowOptions } from "../commands/models/auth.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { HOST_MANAGED_AUTH_LOGIN_MESSAGE } from "../shared/host-managed-auth-error.js";
import {
  buildProviderLoginChoicesReply,
  cancelProviderLoginFlow,
  createProviderLoginFlowRegistry,
  decideProviderLoginSessionAdoption,
  prepareProviderChannelLogin,
  reserveProviderLoginFlow,
  runProviderChannelLoginFlow,
  type ProviderChannelLoginChoice,
} from "./provider-auth-login-flow-runtime.js";

const resolveChoice = vi.hoisted(() =>
  vi.fn<typeof import("../plugins/provider-login-options.js").resolveProviderChannelLoginChoice>(),
);
const resolveOwnership = vi.hoisted(() => vi.fn());
vi.mock("../agents/harness/auth-ownership.js", () => ({
  resolveAgentHarnessAuthOwnership: resolveOwnership,
}));
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
    resolveOwnership.mockReturnValue(undefined);
    resolveChoice.mockReturnValue({ status: "resolved", choice });
  });

  it.each(["/login", "/login refresh", "/login acme", "/login acme/device"])(
    "refuses host-managed %s before starting authentication or refreshing credentials",
    async (commandText) => {
      resolveOwnership.mockReturnValue("host");
      const refreshAuth = vi.fn(async () => {});
      expect(
        await prepareProviderChannelLogin({
          commandText,
          commandAuthorized: true,
          senderIsOwner: true,
          isPrivateChat: true,
          config: { commands: { ownerAllowFrom: ["owner"] } },
          agentId: "worker",
          currentProvider: "acme-cloud",
          currentModelId: "test-model",
          sessionKey: "agent:worker:main",
          refreshAuth,
        }),
      ).toEqual({ status: "rejected", reply: { text: HOST_MANAGED_AUTH_LOGIN_MESSAGE } });
      expect(resolveOwnership).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: "acme-cloud",
          modelId: "test-model",
          agentId: "worker",
          sessionKey: "agent:worker:main",
        }),
      );
      expect(refreshAuth).not.toHaveBeenCalled();
    },
  );

  it("refuses a host-owned secure-input choice instead of handing off to another login", async () => {
    resolveOwnership.mockReturnValue("host");
    resolveChoice.mockReturnValue({ status: "resolved", choice: { ...choice, mode: "secret" } });
    expect(
      await prepareProviderChannelLogin({
        commandText: "/login acme/api-key",
        commandAuthorized: true,
        senderIsOwner: true,
        isPrivateChat: false,
        config: { commands: { ownerAllowFrom: ["owner"] } },
        agentId: "main",
        refreshAuth: async () => {},
      }),
    ).toMatchObject({ status: "rejected", reply: { text: HOST_MANAGED_AUTH_LOGIN_MESSAGE } });
  });

  it("allows an unrelated provider while the current model uses host-managed auth", async () => {
    resolveOwnership.mockImplementation(({ provider }) =>
      provider === "host-provider" ? "host" : undefined,
    );
    expect(
      await prepareProviderChannelLogin({
        commandText: "/login acme",
        commandAuthorized: true,
        senderIsOwner: true,
        isPrivateChat: true,
        config: { commands: { ownerAllowFrom: ["owner"] } },
        agentId: "main",
        currentProvider: "host-provider",
        refreshAuth: async () => {},
      }),
    ).toEqual({ status: "ready", choice });
  });

  it("rejects an in-progress login if the host takes ownership before a credential write", async () => {
    const persist = vi.fn();
    const runLoginFlow = async (opts: ModelsAuthLoginFlowOptions) => {
      await Promise.resolve();
      resolveOwnership.mockReturnValue("host");
      await opts.beforePersistentEffect?.();
      persist();
      return {
        providerId: "acme-cloud",
        methodId: "device-code",
        authRefresh: "refreshed",
        profiles: [{ profileId: "acme-cloud:new", provider: "acme-cloud", mode: "oauth" }],
      };
    };
    await expect(runProviderChannelLoginFlow({ ...loginParams, runLoginFlow })).rejects.toThrow(
      HOST_MANAGED_AUTH_LOGIN_MESSAGE,
    );
    expect(persist).not.toHaveBeenCalled();
  });

  it("authorizes private cancellation and leaves other conversations active", async () => {
    resolveOwnership.mockReturnValue("host");
    const flows = createProviderLoginFlowRegistry();
    const first = reserveProviderLoginFlow({ flows, flowKey: "first", providerLabel: "Acme" });
    const other = reserveProviderLoginFlow({ flows, flowKey: "other", providerLabel: "Other" });
    const params = {
      commandText: "/login cancel",
      commandAuthorized: true,
      senderIsOwner: true,
      isPrivateChat: true,
      config: { commands: { ownerAllowFrom: ["owner"] } },
      agentId: "main",
      refreshAuth: async () => {},
      cancelLogin: () => cancelProviderLoginFlow({ flows, flowKey: "first" }),
    };
    await prepareProviderChannelLogin({ ...params, senderIsOwner: false });
    await prepareProviderChannelLogin({ ...params, commandAuthorized: false });
    await prepareProviderChannelLogin({ ...params, isPrivateChat: false });
    expect(flows.logins.size).toBe(2);
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

  it.each(["before", "after"] as const)(
    "allows another login when the caller cancels %s reservation",
    (timing) => {
      const flows = createProviderLoginFlowRegistry();
      const controller = new AbortController();
      const params = { flows, flowKey: "chat", providerLabel: "Acme" };
      if (timing === "before") {
        controller.abort();
      }
      reserveProviderLoginFlow({ ...params, signal: controller.signal });
      controller.abort();

      const replacement = reserveProviderLoginFlow(params);
      try {
        expect(replacement.status).toBe("reserved");
      } finally {
        cancelProviderLoginFlow(params);
      }
    },
  );

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
