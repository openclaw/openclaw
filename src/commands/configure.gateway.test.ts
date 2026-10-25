import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { CONFIG_PATH } from "../config/paths.js";
import { shortenHomePath } from "../utils.js";

const mocks = vi.hoisted(() => ({
  text: vi.fn(),
  password: vi.fn(),
  select: vi.fn(),
  confirm: vi.fn(),
  resolveGatewayPort: vi.fn(),
  note: vi.fn(),
  randomToken: vi.fn(),
  getTailnetHostname: vi.fn(async (): Promise<string | null> => null),
}));

const chatChannels = vi.hoisted(() => vi.fn<() => Array<{ id: string; label: string }>>(() => []));

vi.mock("../channels/chat-meta.js", () => ({
  listChatChannels: () => chatChannels(),
}));

vi.mock("../config/config.js", async (importActual) => {
  const actual = await importActual<typeof import("../config/config.js")>();
  return { ...actual, resolveGatewayPort: mocks.resolveGatewayPort };
});

vi.mock("./configure.shared.js", () => ({
  text: mocks.text,
  password: mocks.password,
  select: mocks.select,
  confirm: mocks.confirm,
}));

// mock-isolation: Capture wizard notes without writing to the terminal.
vi.mock("../../packages/terminal-core/src/note.js", () => ({ note: mocks.note }));

vi.mock("../infra/tailscale.js", () => ({
  findTailscaleBinary: vi.fn(async () => undefined),
  getTailnetHostname: mocks.getTailnetHostname,
}));

vi.mock("./onboard-helpers.js", async (importActual) => {
  const actual = await importActual<typeof import("./onboard-helpers.js")>();
  return { ...actual, randomToken: mocks.randomToken };
});

import { removeChannelConfigWizard } from "./configure.channels.js";
import { promptGatewayConfig } from "./configure.gateway.js";

async function runGatewayPrompt(params: {
  selectQueue: string[];
  textQueue?: Array<string | undefined>;
  baseConfig?: OpenClawConfig;
  confirmResult?: boolean;
}) {
  vi.clearAllMocks();
  mocks.resolveGatewayPort.mockReturnValue(18789);
  mocks.select.mockImplementation(
    async (input) => params.selectQueue.shift() ?? input.initialValue ?? input.options[0]?.value,
  );
  const text = params.textQueue ?? [];
  mocks.text.mockImplementation(async () => text.shift());
  mocks.password.mockImplementation(async () => text.shift());
  mocks.randomToken.mockReturnValue("generated-token");
  mocks.confirm.mockImplementation(async (input) => params.confirmResult ?? input.initialValue);
  return (await promptGatewayConfig(params.baseConfig ?? {})).config.gateway!;
}

async function runTrustedProxyPrompt(params: {
  textQueue?: Array<string | undefined>;
  proxies?: string;
  bind?: "loopback" | "lan";
  tailscaleMode?: "off" | "serve" | "funnel";
  baseConfig?: OpenClawConfig;
  confirmResult?: boolean;
}) {
  return runGatewayPrompt({
    ...params,
    textQueue: params.textQueue ?? [
      "18789",
      "x-forwarded-user",
      "",
      "",
      params.proxies ?? "127.0.0.1",
    ],
    selectQueue: [params.bind ?? "loopback", "trusted-proxy", params.tailscaleMode ?? "off"],
  });
}

const proxyPrompt = () =>
  mocks.text.mock.calls.find(
    ([options]) => options.message === "Trusted proxy IPs (comma-separated)",
  )?.[0];
const expectLoopbackWarning = (initialValue: boolean) => {
  expect(mocks.confirm).toHaveBeenCalledWith(expect.objectContaining({ initialValue }));
  expect(mocks.note).toHaveBeenCalledWith(
    expect.stringContaining("Any local process"),
    expect.any(String),
  );
};

afterEach(() => vi.unstubAllEnvs());

describe("promptGatewayConfig", () => {
  it("keeps existing auth policy through the real token config builder", async () => {
    const mode = "token";
    const policy = {
      allowTailscale: false,
      rateLimit: { maxAttempts: 3, exemptLoopback: false },
      identityScopes: { "operator@example.test": ["operator.read" as const] },
    };
    const result = await runGatewayPrompt({
      baseConfig: {
        gateway: {
          auth: {
            ...policy,
            mode: "token",
            token: "old-token",
            password: "old-password",
            trustedProxy: { userHeader: "old-header" },
          },
        },
      },
      selectQueue: ["loopback", mode, "off", "plaintext"],
      textQueue: ["18789", `  new-${mode}  `],
    });

    expect(result.auth).toEqual({ ...policy, mode, token: "new-token" });
  });

  it.each([
    ["token", undefined, "plaintext", { mode: "token", token: "generated-token" }],
    ["token", "undefined", "plaintext", { mode: "token", token: "generated-token" }],
    ["password", undefined, "plaintext", { mode: "password" }],
    [
      "token",
      "OPENCLAW_GATEWAY_TOKEN",
      "ref",
      {
        mode: "token",
        token: { source: "env", provider: "default", id: "OPENCLAW_GATEWAY_TOKEN" },
      },
    ],
  ] as const)("stores %s prompt value %j using %s", async (mode, value, source, expected) => {
    if (source === "ref") {
      vi.stubEnv("OPENCLAW_GATEWAY_TOKEN", "env-gateway-token");
    }
    const result = await runGatewayPrompt({
      selectQueue: ["loopback", mode, "off", source],
      textQueue: ["18789", value],
    });
    expect(result.auth).toEqual(expected);
  });

  it("configures proxy headers and disables incompatible Tailscale serve", async () => {
    const result = await runTrustedProxyPrompt({
      bind: "lan",
      tailscaleMode: "serve",
      textQueue: [
        "18789",
        "x-forwarded-user",
        "x-forwarded-proto,x-forwarded-host",
        "nick@example.com",
        "10.0.1.10,192.168.1.5",
      ],
    });

    expect(result.auth).toEqual({
      mode: "trusted-proxy",
      trustedProxy: {
        userHeader: "x-forwarded-user",
        requiredHeaders: ["x-forwarded-proto", "x-forwarded-host"],
        allowUsers: ["nick@example.com"],
      },
    });
    expect(result).toMatchObject({
      bind: "lan",
      trustedProxies: ["10.0.1.10", "192.168.1.5"],
    });
    expect(result.tailscale).toEqual({ mode: "off" });
  });

  it("rejects an empty entry in trusted proxy input", async () => {
    await runTrustedProxyPrompt({ textQueue: ["18789", "x-forwarded-user", "", "", "10.42.0.1"] });
    expect(proxyPrompt().validate("10.42.0.1, ")).toEqual(
      expect.stringMatching(/IPv4.*IPv6.*CIDR/),
    );
  });

  it.each([
    ["::ffff:127.0.0.0/104", true],
    ["::ffff:0:0/96", true],
    ["::1%LO0", false],
  ] as const)(
    "persists proxy configuration and explicit consent for %s",
    async (proxies, consent) => {
      vi.stubEnv("OPENCLAW_LOCALE", "en");
      const mappedLoopback = proxies === "::ffff:127.0.0.0/104";
      const result = await runTrustedProxyPrompt({
        textQueue: [
          "18789",
          "x-forwarded-user",
          mappedLoopback ? "x-forwarded-proto" : "",
          "",
          proxies,
        ],
        confirmResult: true,
      });
      expect(result.trustedProxies).toEqual([proxies]);
      expect(result.auth).toEqual({
        mode: "trusted-proxy",
        trustedProxy: {
          userHeader: "x-forwarded-user",
          ...(mappedLoopback ? { requiredHeaders: ["x-forwarded-proto"] } : {}),
          ...(consent ? { allowLoopback: true } : {}),
        },
      });
      if (consent) {
        expectLoopbackWarning(false);
      } else {
        expect(mocks.confirm).not.toHaveBeenCalled();
      }
      if (mappedLoopback) {
        expect(proxyPrompt().validate(proxies)).toBeUndefined();
      }
    },
  );

  it.each(["fresh", "rerun", "password"] as const)(
    "requires fresh loopback consent: %s",
    async (previous) => {
      vi.stubEnv("OPENCLAW_LOCALE", "en");
      const sameMode = previous === "rerun";
      const auth: NonNullable<OpenClawConfig["gateway"]>["auth"] = {
        mode: sameMode ? "trusted-proxy" : "password",
        ...(sameMode ? {} : { password: "old-password" }),
        trustedProxy: {
          userHeader: "x-old-user",
          allowLoopback: true,
          deviceAutoApprove: sameMode ? { enabled: false, scopes: [] } : { enabled: true },
        },
      };
      const baseConfig = previous === "fresh" ? {} : { gateway: { auth } };
      const original = structuredClone(baseConfig);
      const result = await runTrustedProxyPrompt({ baseConfig, confirmResult: false });
      expect(result.auth).toEqual({
        mode: "trusted-proxy",
        trustedProxy: {
          userHeader: "x-forwarded-user",
          ...(sameMode ? { deviceAutoApprove: { enabled: false, scopes: [] } } : {}),
        },
      });
      expect(baseConfig).toEqual(original);
      expectLoopbackWarning(sameMode);
      const refusalMessage = mocks.note.mock.calls.at(-1)?.[0];
      expect(refusalMessage).toContain("will be rejected");
      expect(refusalMessage).toContain("trusted_proxy_loopback_source");
      expect(refusalMessage).toContain("https://docs.openclaw.ai/gateway/trusted-proxy-auth");
    },
  );

  it("adds a valid IPv6 HTTPS origin for Tailscale funnel", async () => {
    mocks.getTailnetHostname.mockResolvedValue("fd7a:115c:a1e0::12");
    const result = await runGatewayPrompt({
      selectQueue: ["loopback", "password", "funnel"],
      textQueue: ["18789", "my-token"],
      confirmResult: true,
    });
    expect(result.controlUi?.allowedOrigins).toEqual(["https://[fd7a:115c:a1e0::12]"]);
  });
});

const { select, confirm, note } = mocks;
const channelChoice = (id: string) => ({ kind: "channel" as const, id });
const doneChoice = { kind: "done" as const };
const configPathLabel = shortenHomePath(CONFIG_PATH);
it.each([
  { id: "telegram", label: "Telegram\u001B[31m\nBot\u0007", expected: "Telegram\\nBot" },
  { id: "\u001B[31m\u0007", label: undefined, expected: "<invalid channel key>" },
])("sanitizes channel removal labels ($expected)", async ({ id, label, expected }) => {
  vi.resetAllMocks();
  chatChannels.mockReturnValue([{ id: "telegram", label: label ?? "Telegram" }]);
  confirm.mockResolvedValue(true);
  select.mockResolvedValueOnce(channelChoice(id)).mockResolvedValueOnce(doneChoice);
  const next = await removeChannelConfigWizard({
    channels: { [id]: { token: "secret" }, telegram: { token: "secret" } },
  } as never);
  expect(select.mock.calls[0]?.[0].options).toContainEqual(
    expect.objectContaining({ value: channelChoice(id), label: expected }),
  );
  expect(confirm.mock.calls[0]?.[0].message).toBe(
    `Delete ${expected} configuration from ${configPathLabel}?`,
  );
  expect(note).toHaveBeenCalledWith(
    `${expected} selected for removal from config.\nNote: credentials/sessions on disk are unchanged.`,
    "Channel removal",
  );
  expect(next.channels).toEqual(label ? undefined : { telegram: { token: "secret" } });
});
