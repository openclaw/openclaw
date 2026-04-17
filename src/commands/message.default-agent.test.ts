import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CliDeps } from "../cli/outbound-send-deps.js";
import type { RuntimeEnv } from "../runtime.js";
import { messageCommand } from "./message.js";

let testConfig: Record<string, unknown> = {};
const resolveCommandConfigWithSecrets = vi.hoisted(() =>
  vi.fn(async ({ config }: { config: unknown }) => ({
    resolvedConfig: config,
    effectiveConfig: config,
    diagnostics: [] as string[],
  })),
);
const runMessageAction = vi.hoisted(() =>
  vi.fn(async () => ({
    kind: "send" as const,
    channel: "telegram" as const,
    action: "send" as const,
    to: "123456",
    handledBy: "core" as const,
    payload: { ok: true },
    dryRun: false,
  })),
);

vi.mock("../config/config.js", () => ({
  loadConfig: () => testConfig,
}));

vi.mock("../cli/command-config-resolution.js", () => ({
  resolveCommandConfigWithSecrets,
}));

vi.mock("../infra/outbound/message-action-runner.js", () => ({
  runMessageAction,
}));

describe("messageCommand agent routing", () => {
  beforeEach(() => {
    testConfig = {};
    resolveCommandConfigWithSecrets.mockClear();
    runMessageAction.mockClear();
  });

  it("passes resolved command config and scoped secret targets to the outbound runner", async () => {
    const rawConfig = {
      channels: {
        telegram: {
          token: { $secret: "vault://telegram/token" },
        },
      },
    };
    const resolvedConfig = {
      channels: {
        telegram: {
          token: "12345:resolved-token",
        },
      },
    };
    testConfig = rawConfig;
    resolveCommandConfigWithSecrets.mockResolvedValueOnce({
      resolvedConfig,
      effectiveConfig: resolvedConfig,
      diagnostics: [],
    });

    const runtime: RuntimeEnv = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    };
    await messageCommand(
      {
        action: "send",
        channel: "telegram",
        target: "123456",
        message: "hi",
        json: true,
      },
      {} as CliDeps,
      runtime,
    );

    expect(resolveCommandConfigWithSecrets).toHaveBeenCalledWith(
      expect.objectContaining({
        config: rawConfig,
        commandName: "message",
      }),
    );
    const call = resolveCommandConfigWithSecrets.mock.calls[0]?.[0] as {
      targetIds?: Set<string>;
    };
    expect(call.targetIds).toBeInstanceOf(Set);
    expect([...(call.targetIds ?? [])].every((id) => id.startsWith("channels.telegram."))).toBe(
      true,
    );
    expect(runMessageAction).toHaveBeenCalledWith(
      expect.objectContaining({
        cfg: resolvedConfig,
      }),
    );
  });

  it("passes the resolved default agent id to the outbound runner", async () => {
    testConfig = {
      agents: {
        list: [{ id: "alpha" }, { id: "ops", default: true }],
      },
    };

    const runtime: RuntimeEnv = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    };
    await messageCommand(
      {
        action: "send",
        channel: "telegram",
        target: "123456",
        message: "hi",
        json: true,
      },
      {} as CliDeps,
      runtime,
    );

    expect(runMessageAction).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "ops",
      }),
    );
  });

  it.each([
    {
      name: "defaults senderIsOwner to true for local message runs",
      opts: {},
      expected: true,
    },
    {
      name: "honors explicit senderIsOwner override",
      opts: { senderIsOwner: false },
      expected: false,
    },
  ])("$name", async ({ opts, expected }) => {
    const runtime: RuntimeEnv = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    };
    await messageCommand(
      {
        action: "send",
        channel: "telegram",
        target: "123456",
        message: "hi",
        json: true,
        ...opts,
      },
      {} as CliDeps,
      runtime,
    );

    expect(runMessageAction).toHaveBeenCalledWith(
      expect.objectContaining({
        senderIsOwner: expected,
      }),
    );
  });
});
