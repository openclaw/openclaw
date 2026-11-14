import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelsAuthLoginFlowOptions } from "../commands/models/auth.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
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
const loginResult = {
  providerId: "acme-cloud",
  methodId: "device-code",
  authRefresh: "refreshed",
  profiles: [{ profileId: "acme-cloud:new", provider: "acme-cloud", mode: "oauth" }],
};

type LoginOptions = Parameters<typeof runProviderChannelLoginFlow>[0];
function runLogin(options: Omit<LoginOptions, keyof typeof loginParams> & Partial<LoginOptions>) {
  return runProviderChannelLoginFlow({ ...loginParams, ...options });
}
const unavailable = (options: Parameters<typeof runLogin>[0]) =>
  expect(runLogin(options)).rejects.toThrow("no longer available");
const pluginConfig = (enabled: boolean): OpenClawConfig => ({
  plugins: { entries: { acme: { enabled } } },
});

describe("provider channel login runtime", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveChoice.mockReturnValue({ status: "resolved", choice });
  });

  it("authorizes private cancellation and leaves other conversations active", async () => {
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

  it.each(["entry", "write", "url", "device-code"] as const)(
    "rejects a disabled provider at the retained %s checkpoint",
    async (checkpoint) => {
      const config = pluginConfig(true);
      let currentConfig = config;
      resolveChoice.mockImplementation((_input, params) =>
        params?.config?.plugins?.entries?.acme?.enabled === false
          ? { status: "unsupported", choices: [] }
          : { status: "resolved", choice },
      );
      const persist = vi.fn();
      const sendDeviceCode = vi.fn();
      const runLoginFlow = vi.fn(async (opts: ModelsAuthLoginFlowOptions) => {
        await Promise.resolve();
        currentConfig = pluginConfig(false);
        if (checkpoint === "write") {
          opts.assertCurrent?.();
          persist();
        } else if (checkpoint === "url") {
          await opts.openUrl?.("https://example.com/login");
        } else {
          await opts.prompter.deviceCode?.({ title: "Sign in", code: "ABCD-EFGH" });
        }
        return loginResult;
      });
      if (checkpoint === "entry") {
        currentConfig = pluginConfig(false);
      }
      await unavailable({ config, readConfig: () => currentConfig, runLoginFlow, sendDeviceCode });
      if (checkpoint === "entry") {
        expect(runLoginFlow).not.toHaveBeenCalled();
      }
      expect(persist).not.toHaveBeenCalled();
      expect(loginParams.sendMessage).not.toHaveBeenCalled();
      expect(sendDeviceCode).not.toHaveBeenCalled();
    },
  );

  it.each(["before", "after"] as const)(
    "honors caller revocation %s credential persistence",
    async (timing) => {
      const config: OpenClawConfig = { commands: { ownerAllowFrom: ["owner"] } };
      let currentConfig = config;
      const revoke = () => {
        currentConfig = { commands: { ownerAllowFrom: ["replacement"] } };
      };
      const persist = vi.fn();
      const result = runLogin({
        config,
        readConfig: () => currentConfig,
        runLoginFlow: async (opts) => {
          await Promise.resolve();
          if (timing === "before") {
            revoke();
          }
          opts.assertCurrent?.();
          persist();
          if (timing === "after") {
            revoke();
          }
          return loginResult;
        },
        assertCurrent: (current) => {
          if (!current.commands?.ownerAllowFrom?.includes("owner")) {
            throw new Error("Caller no longer owns this login.");
          }
        },
      });
      if (timing === "before") {
        await expect(result).rejects.toThrow("Caller no longer owns this login");
        expect(persist).not.toHaveBeenCalled();
      } else {
        expect((await result).profiles).toEqual(loginResult.profiles);
        expect(loginParams.sendMessage).not.toHaveBeenCalled();
      }
    },
  );

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

  it.each(["pluginId", "providerId", "methodId"] as const)(
    "rejects a stale %s before the provider can start",
    async (field) => {
      resolveChoice.mockReturnValue({
        status: "resolved",
        choice: { ...choice, [field]: "replacement" },
      });
      const runLoginFlow = vi.fn();
      await unavailable({ runLoginFlow });
      expect(runLoginFlow).not.toHaveBeenCalled();
    },
  );

  it("passes the selected owner and forbids chat credential input", async () => {
    const runLoginFlow = async (opts: ModelsAuthLoginFlowOptions) => {
      expect(opts).toMatchObject({
        ownerPluginId: "acme",
        provider: "acme-cloud",
        method: "device-code",
        credentialOnly: true,
      });
      await opts.prompter.text({ message: "Enter your API key" });
    };
    await expect(runLogin({ runLoginFlow })).rejects.toThrow("Open Control UI");
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
