import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ModelsAuthLoginFlowOptions,
  ModelsAuthLoginFlowResult,
} from "../commands/models/auth.js";
import {
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
const runLoginFlow = vi.hoisted(() =>
  vi.fn<(opts: ModelsAuthLoginFlowOptions) => Promise<ModelsAuthLoginFlowResult>>(),
);
// mock-isolation: the core login flow writes config and auth stores; these tests observe only its options.
vi.mock("../commands/models/auth.js", () => ({ runModelsAuthLoginFlowCore: runLoginFlow }));
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
};
const loginResult: ModelsAuthLoginFlowResult = {
  providerId: "acme-cloud",
  methodId: "device-code",
  authRefresh: "refreshed",
  profiles: [{ profileId: "acme-cloud:new", provider: "acme-cloud", mode: "oauth" }],
};

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

  it("passes the selected owner and forbids chat credential input", async () => {
    runLoginFlow.mockImplementationOnce(async (opts) => {
      expect(opts).toMatchObject({
        ownerPluginId: "acme",
        provider: "acme-cloud",
        method: "device-code",
        credentialOnly: true,
      });
      await opts.prompter.text({ message: "Enter your API key" });
      return loginResult;
    });
    await expect(runProviderChannelLoginFlow(loginParams)).rejects.toThrow(
      "Open Models in the OpenClaw app",
    );
    // The failure renderer owns the one message; the prompter sends none.
    expect(loginParams.sendMessage).not.toHaveBeenCalled();
  });

  it("keeps every provider button and its text fallback bound to the same command", async () => {
    const providers = Array.from({ length: 12 }, (_, index) => ({
      pluginId: `plugin-${index}`,
      providerId: `provider-${index}`,
      label: `Provider ${index}`,
    }));
    resolveChoice.mockReturnValue({ status: "providers", providers });
    const prepared = await prepareProviderChannelLogin({
      commandText: "/login",
      commandAuthorized: true,
      senderIsOwner: true,
      isPrivateChat: true,
      config: { commands: { ownerAllowFrom: ["owner"] } },
      agentId: "main",
      refreshAuth: async () => {},
    });
    const reply = prepared?.status === "reply" ? prepared.reply : expect.unreachable();
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
