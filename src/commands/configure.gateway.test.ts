import { IncomingMessage } from "node:http";
import { Socket } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { CONFIG_PATH } from "../config/paths.js";
import { authorizeHttpGatewayConnect, resolveGatewayAuth } from "../gateway/auth.js";
import { isTrustedProxyAddress } from "../gateway/net.js";
import type { RuntimeEnv } from "../runtime.js";
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

const chatChannels = vi.hoisted(() =>
  vi.fn(() => [
    { id: "telegram", label: "Telegram" },
    { id: "twitch", label: "Twitch" },
  ]),
);

vi.mock("../channels/chat-meta.js", () => ({
  listChatChannels: () => chatChannels(),
}));

vi.mock("../config/config.js", async (importActual) => {
  const actual = await importActual<typeof import("../config/config.js")>();
  return {
    ...actual,
    resolveGatewayPort: mocks.resolveGatewayPort,
  };
});

vi.mock("./configure.shared.js", () => ({
  text: mocks.text,
  password: mocks.password,
  select: mocks.select,
  confirm: mocks.confirm,
}));

vi.mock("../../packages/terminal-core/src/note.js", () => ({
  note: mocks.note,
}));

vi.mock("../infra/tailscale.js", () => ({
  findTailscaleBinary: vi.fn(async () => undefined),
  getTailnetHostname: mocks.getTailnetHostname,
}));

vi.mock("./onboard-helpers.js", async (importActual) => {
  const actual = await importActual<typeof import("./onboard-helpers.js")>();
  return {
    ...actual,
    randomToken: mocks.randomToken,
  };
});

import { removeChannelConfigWizard } from "./configure.channels.js";
import { promptGatewayConfig } from "./configure.gateway.js";

const makeRuntime = (): RuntimeEnv => ({ log: vi.fn(), error: vi.fn(), exit: vi.fn() });

async function runGatewayPrompt(params: {
  selectQueue: string[];
  textQueue: Array<string | undefined>;
  baseConfig?: OpenClawConfig;
  randomToken?: string;
  confirmResult?: boolean;
}) {
  vi.clearAllMocks();
  mocks.resolveGatewayPort.mockReturnValue(18789);
  mocks.select.mockImplementation(async (input) => {
    const next = params.selectQueue.shift();
    if (next !== undefined) {
      return next;
    }
    return input.initialValue ?? input.options[0]?.value;
  });
  mocks.text.mockImplementation(async () => params.textQueue.shift());
  mocks.password.mockImplementation(async () => params.textQueue.shift());
  mocks.randomToken.mockReturnValue(params.randomToken ?? "generated-token");
  mocks.confirm.mockImplementation(async (input) => params.confirmResult ?? input.initialValue);
  return promptGatewayConfig(params.baseConfig ?? {}, makeRuntime());
}

async function runTrustedProxyPrompt(params: {
  textQueue: Array<string | undefined>;
  bind?: "loopback" | "lan";
  tailscaleMode?: "off" | "serve" | "funnel";
  baseConfig?: OpenClawConfig;
  confirmResult?: boolean;
}) {
  return runGatewayPrompt({
    ...params,
    selectQueue: [params.bind ?? "loopback", "trusted-proxy", params.tailscaleMode ?? "off"],
  });
}

afterEach(() => vi.unstubAllEnvs());

async function authorizeConfiguredProxy(config: OpenClawConfig, remoteAddress = "127.0.0.1") {
  const req = new IncomingMessage(new Socket());
  Object.defineProperty(req.socket, "remoteAddress", { value: remoteAddress });
  req.headers = {
    host: "localhost",
    "x-forwarded-for": "203.0.113.10",
    "x-forwarded-user": "operator@example.test",
    "x-forwarded-proto": "https",
  };
  try {
    return await authorizeHttpGatewayConnect({
      auth: resolveGatewayAuth({ authConfig: config.gateway?.auth, env: {} }),
      trustedProxies: config.gateway?.trustedProxies,
      req,
    });
  } finally {
    req.destroy();
  }
}

describe("promptGatewayConfig", () => {
  it.each(["token", "password", "trusted-proxy"] as const)(
    "keeps existing auth policy through the real %s config builder",
    async (mode) => {
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
        textQueue:
          mode === "trusted-proxy"
            ? ["18789", "x-forwarded-user", "", "", "10.0.0.1"]
            : ["18789", `  new-${mode}  `],
      });

      expect(result.config.gateway?.auth).toEqual({
        ...policy,
        mode,
        ...{
          token: { token: "new-token" },
          password: { password: "new-password" },
          "trusted-proxy": { trustedProxy: { userHeader: "x-forwarded-user" } },
        }[mode],
      });
    },
  );

  it.each([undefined, "undefined"])("generates a token for prompt value %j", async (token) => {
    const result = await runGatewayPrompt({
      selectQueue: ["loopback", "token", "off", "plaintext"],
      textQueue: ["18789", token],
      randomToken: "generated-token",
    });
    expect(result.token).toBe("generated-token");
    expect(result.config.gateway?.auth).toEqual({ mode: "token", token: result.token });
    expect(mocks.password).toHaveBeenCalledOnce();
  });

  it("does not set password to literal 'undefined' when prompt returns undefined", async () => {
    const result = await runGatewayPrompt({
      selectQueue: ["loopback", "password", "off"],
      textQueue: ["18789", undefined],
      randomToken: "unused",
    });
    expect(result.config.gateway?.auth).toEqual({ mode: "password" });
    expect(mocks.password).toHaveBeenCalledOnce();
  });

  it.each(["serve", "funnel"] as const)(
    "configures proxy headers and disables incompatible Tailscale %s",
    async (tailscaleMode) => {
      const result = await runTrustedProxyPrompt({
        bind: "lan",
        tailscaleMode,
        textQueue: [
          "18789",
          "x-forwarded-user",
          "x-forwarded-proto,x-forwarded-host",
          "nick@example.com",
          "10.0.1.10,192.168.1.5",
        ],
      });

      expect(result.config.gateway?.auth).toEqual({
        mode: "trusted-proxy",
        trustedProxy: {
          userHeader: "x-forwarded-user",
          requiredHeaders: ["x-forwarded-proto", "x-forwarded-host"],
          allowUsers: ["nick@example.com"],
        },
      });
      expect(result.config.gateway?.bind).toBe("lan");
      expect(result.config.gateway?.trustedProxies).toEqual(["10.0.1.10", "192.168.1.5"]);
      expect(result.config.gateway?.tailscale).toEqual({ mode: "off" });
    },
  );

  it.each([
    [" 10.42.0.1 , \t2001:db8::/32 ", true],
    ["10.42.0.1, ", false],
  ])("validates trusted proxy input %j (valid=%s)", async (input, valid) => {
    await runTrustedProxyPrompt({
      textQueue: ["18789", "x-forwarded-user", "", "", "10.42.0.1"],
    });
    const prompt = mocks.text.mock.calls.find(
      ([options]) => options.message === "Trusted proxy IPs (comma-separated)",
    )?.[0];
    expect(prompt?.validate).toBeTypeOf("function");
    expect(prompt.validate(input)).toEqual(
      valid ? undefined : expect.stringMatching(/IPv4.*IPv6.*CIDR/),
    );
  });

  it.each([["::ffff:127.0.0.0/104", "127.0.0.1"]])(
    "accepts runtime auth after consent for loopback proxy %s",
    async (proxies, remoteAddress) => {
      vi.stubEnv("OPENCLAW_LOCALE", "en");
      const result = await runTrustedProxyPrompt({
        textQueue: ["18789", "x-forwarded-user", "x-forwarded-proto", "", proxies],
        confirmResult: true,
      });
      expect(result.config.gateway?.auth?.trustedProxy?.allowLoopback).toBe(true);
      const prompt = mocks.text.mock.calls.find(
        ([options]) => options.message === "Trusted proxy IPs (comma-separated)",
      )?.[0];
      expect(prompt.validate(proxies)).toBeUndefined();
      expect(mocks.confirm).toHaveBeenCalledWith(expect.objectContaining({ initialValue: false }));
      expect(mocks.note).toHaveBeenCalledWith(
        expect.stringContaining("Any local process"),
        expect.any(String),
      );
      expect(await authorizeConfiguredProxy(result.config, remoteAddress)).toEqual({
        ok: true,
        method: "trusted-proxy",
        user: "operator@example.test",
      });
    },
  );

  it("rejects proxy attribution through an IPv4 catch-all", async () => {
    const proxies = "::ffff:0:0/96";
    const result = await runTrustedProxyPrompt({
      textQueue: ["18789", "x-forwarded-user", "", "", proxies],
      confirmResult: true,
    });
    expect(mocks.confirm).toHaveBeenCalledWith(expect.objectContaining({ initialValue: false }));
    expect(result.config.gateway?.auth?.trustedProxy?.allowLoopback).toBe(true);
    expect(isTrustedProxyAddress("127.0.0.1", result.config.gateway?.trustedProxies)).toBe(true);
    // Every IPv4 hop is trusted, so the forwarded client address is consumed as a proxy too.
    expect(await authorizeConfiguredProxy(result.config, "127.0.0.1")).toEqual({
      ok: false,
      reason: "proxy_attribution_required",
    });
  });

  it("does not grant loopback consent for an unmatched IPv6 zone", async () => {
    const proxies = "::1%LO0";
    const result = await runTrustedProxyPrompt({
      textQueue: ["18789", "x-forwarded-user", "", "", proxies],
    });
    expect(mocks.confirm).not.toHaveBeenCalled();
    expect(result.config.gateway?.auth?.trustedProxy?.allowLoopback).toBeUndefined();
    for (const peer of ["127.0.0.1", "::1", "::1%LO0"]) {
      expect(isTrustedProxyAddress(peer, result.config.gateway?.trustedProxies)).toBe(false);
      expect(await authorizeConfiguredProxy(result.config, peer)).toMatchObject({ ok: false });
    }
  });

  it("warns and rejects auth when loopback consent is refused", async () => {
    vi.stubEnv("OPENCLAW_LOCALE", "en");
    const result = await runTrustedProxyPrompt({
      textQueue: ["18789", "x-forwarded-user", "", "", "127.0.0.1"],
      confirmResult: false,
    });
    expect(result.config.gateway?.auth?.trustedProxy?.allowLoopback).toBeUndefined();
    expect(mocks.note).toHaveBeenCalledWith(
      expect.stringContaining("Any local process"),
      expect.any(String),
    );
    expect(mocks.confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining("Allow loopback"),
        initialValue: false,
      }),
    );
    const refusalMessage = mocks.note.mock.calls.at(-1)?.[0];
    expect(refusalMessage).toContain("will be rejected");
    expect(refusalMessage).toContain("trusted_proxy_loopback_source");
    expect(refusalMessage).toContain("https://docs.openclaw.ai/gateway/trusted-proxy-auth");
    expect(await authorizeConfiguredProxy(result.config)).toMatchObject({
      ok: false,
      reason: "trusted_proxy_loopback_source",
    });
  });

  it.each([
    { proxies: "127.0.0.1", answer: false, expected: undefined },
    { proxies: "10.0.0.1", answer: undefined, expected: true },
  ])(
    "preserves or explicitly revokes loopback consent on rerun: $proxies/$answer",
    async ({ proxies, answer, expected }) => {
      const baseConfig: OpenClawConfig = {
        gateway: {
          auth: {
            mode: "trusted-proxy",
            trustedProxy: {
              userHeader: "x-old-user",
              allowLoopback: true,
              deviceAutoApprove: { enabled: false, scopes: [] },
            },
          },
        },
      };
      const original = structuredClone(baseConfig);
      const result = await runTrustedProxyPrompt({
        baseConfig,
        textQueue: ["18789", "x-forwarded-user", "", "", proxies],
        confirmResult: answer,
      });
      expect(result.config.gateway?.auth?.trustedProxy).toEqual({
        userHeader: "x-forwarded-user",
        allowLoopback: expected,
        deviceAutoApprove: { enabled: false, scopes: [] },
      });
      expect(baseConfig).toEqual(original);
      if (proxies === "127.0.0.1") {
        expect(mocks.confirm).toHaveBeenCalledWith(expect.objectContaining({ initialValue: true }));
      } else {
        expect(mocks.confirm).not.toHaveBeenCalled();
      }
    },
  );

  it("does not revive dormant trusted-proxy consent when switching modes", async () => {
    const result = await runTrustedProxyPrompt({
      baseConfig: {
        gateway: {
          auth: {
            mode: "password",
            password: "old-password",
            trustedProxy: {
              userHeader: "x-old-user",
              allowLoopback: true,
              deviceAutoApprove: { enabled: true },
            },
          },
        },
      },
      textQueue: ["18789", "x-forwarded-user", "", "", "127.0.0.1"],
    });
    expect(mocks.confirm).toHaveBeenCalledWith(expect.objectContaining({ initialValue: false }));
    expect(result.config.gateway?.auth).toEqual({
      mode: "trusted-proxy",
      trustedProxy: { userHeader: "x-forwarded-user" },
    });
  });

  it("adds a valid IPv6 HTTPS origin for Tailscale funnel", async () => {
    mocks.getTailnetHostname.mockResolvedValue("fd7a:115c:a1e0::12");
    const result = await runGatewayPrompt({
      selectQueue: ["loopback", "password", "funnel"],
      textQueue: ["18789", "my-token"],
      confirmResult: true,
    });
    expect(result.config.gateway?.controlUi?.allowedOrigins).toEqual([
      "https://[fd7a:115c:a1e0::12]",
    ]);
  });

  it("stores gateway token as SecretRef when token source is ref", async () => {
    vi.stubEnv("OPENCLAW_GATEWAY_TOKEN", "env-gateway-token");
    const result = await runGatewayPrompt({
      selectQueue: ["loopback", "token", "off", "ref"],
      textQueue: ["18789", "OPENCLAW_GATEWAY_TOKEN"],
    });

    expect(result.config.gateway?.auth).toEqual({
      mode: "token",
      token: {
        source: "env",
        provider: "default",
        id: "OPENCLAW_GATEWAY_TOKEN",
      },
    });
    expect(result.token).toBeUndefined();
  });
});

const { select, confirm, note } = mocks;
const channelChoice = (id: string) => ({ kind: "channel" as const, id });
const doneChoice = { kind: "done" as const };
const configPathLabel = shortenHomePath(CONFIG_PATH);

async function removeChannelConfig(channel: string) {
  select.mockResolvedValueOnce(channelChoice(channel)).mockResolvedValueOnce(doneChoice);

  return removeChannelConfigWizard(
    {
      channels: {
        [channel]: { token: "secret" },
        telegram: { token: "secret" },
      },
    } as never,
    {} as never,
  );
}

function expectOption(value: unknown, label: string) {
  expect(select.mock.calls[0]?.[0].options).toContainEqual(
    expect.objectContaining({ value, label }),
  );
}

function expectUnknownChannelRemovalPrompt(unsafeChannel: string, label: string) {
  expectOption(channelChoice(unsafeChannel), label);
  expect(confirm.mock.calls[0]?.[0].message).toBe(
    `Delete ${label} configuration from ${configPathLabel}?`,
  );
  expect(note).toHaveBeenCalledWith(
    `${label} selected for removal from config.\nNote: credentials/sessions on disk are unchanged.`,
    "Channel removal",
  );
}

describe("removeChannelConfigWizard", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    chatChannels.mockReturnValue([
      { id: "telegram", label: "Telegram" },
      { id: "twitch", label: "Twitch" },
    ]);
    confirm.mockResolvedValue(true);
  });

  it("lists configured channels from openclaw.json even when no plugins are loaded", async () => {
    select.mockResolvedValue(doneChoice);

    await removeChannelConfigWizard(
      {
        channels: {
          defaults: { groupPolicy: "open" },
          modelByChannel: { openai: { telegram: "gpt-5.4" } },
          constructor: {},
          prototype: {},
          twitch: {},
          unknown: {},
          telegram: {},
        },
      } as never,
      {} as never,
    );

    const prompt = select.mock.calls[0]?.[0];
    expect(prompt.message).toBe("Remove which channel config?");
    expect(prompt.options).toMatchObject([
      { value: channelChoice("telegram"), label: "Telegram" },
      { value: channelChoice("twitch"), label: "Twitch" },
      { value: channelChoice("unknown"), label: "unknown" },
      { value: doneChoice, label: "Done" },
    ]);
  });

  it("removes a channel named done while preserving channel-wide defaults", async () => {
    select.mockResolvedValueOnce(channelChoice("done")).mockResolvedValueOnce(doneChoice);
    const defaults = { groupPolicy: "open" as const };
    const modelByChannel = { openai: { telegram: "gpt-5.4" } };
    const next = await removeChannelConfigWizard(
      { channels: { defaults, modelByChannel, done: {} } },
      {} as never,
    );
    expect(next.channels).toEqual({ defaults, modelByChannel });
    expect(confirm.mock.calls[0]?.[0].message).toBe(
      `Delete done configuration from ${configPathLabel}?`,
    );
  });

  it.each([
    { id: "telegram", label: "Telegram\u001B[31m\nBot\u0007", expected: "Telegram\\nBot" },
    { id: "bad\u001B[31m\nkey\u0007", label: undefined, expected: "bad\\nkey" },
    { id: "\u001B[31m\u0007", label: undefined, expected: "<invalid channel key>" },
  ])("sanitizes channel prompt labels ($expected)", async ({ id, label, expected }) => {
    if (label) {
      chatChannels.mockReturnValue([{ id, label }]);
    }
    const next = await removeChannelConfig(id);
    expectUnknownChannelRemovalPrompt(id, expected);
    expect(next.channels).toEqual(label ? undefined : { telegram: { token: "secret" } });
  });
});
