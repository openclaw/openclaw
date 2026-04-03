import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CliDeps } from "../cli/outbound-send-deps.js";
import type { RuntimeEnv } from "../runtime.js";
import { messageCommand } from "./message.js";

let testConfig: Record<string, unknown> = {};

const resolveCommandSecretRefsViaGateway = vi.hoisted(() =>
  vi.fn(async ({ config }: { config: unknown }) => ({
    resolvedConfig: config,
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

vi.mock("../config/config.js", async () => {
  const actual = await vi.importActual<typeof import("../config/config.js")>("../config/config.js");
  return {
    ...actual,
    loadConfig: () => testConfig,
  };
});

vi.mock("../cli/command-secret-gateway.js", () => ({
  resolveCommandSecretRefsViaGateway,
}));

vi.mock("../infra/outbound/message-action-runner.js", () => ({
  runMessageAction,
}));

describe("messageCommand agent routing", () => {
  beforeEach(() => {
    testConfig = {};
    resolveCommandSecretRefsViaGateway.mockClear();
    runMessageAction.mockClear();
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
});
