import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelsAuthLoginFlowOptions } from "../commands/models/auth.js";
import {
  buildProviderLoginChoicesReply,
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
      expect(button.action.type).toBe("command");
      if (button.action.type === "command") {
        expect(reply.text).toContain(`${button.label}: \`${button.action.command}\``);
      }
    }
    expect(reply.text).toContain("/login oauth/plugin-11/provider-11");
  });
});
