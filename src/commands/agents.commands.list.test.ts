import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { OutputRuntimeEnv } from "../runtime.js";

const { buildProviderStatusIndexMock, requireValidConfigMock } = vi.hoisted(() => ({
  buildProviderStatusIndexMock: vi.fn(),
  requireValidConfigMock: vi.fn(),
}));

vi.mock("./agents.command-shared.js", () => ({
  requireValidConfig: requireValidConfigMock,
}));

vi.mock("./agents.providers.js", () => ({
  buildProviderStatusIndex: buildProviderStatusIndexMock,
  listProvidersForAgent: () => ["Telegram default: configured"],
  summarizeBindings: () => ["Telegram default"],
}));

const { agentsListCommand } = await import("./agents.commands.list.js");

function createRuntime(): OutputRuntimeEnv & { json: unknown[] } {
  const json: unknown[] = [];
  return {
    json,
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn(),
    writeStdout: vi.fn(),
    writeJson: vi.fn((value: unknown) => {
      json.push(value);
    }),
  };
}

function createConfig(): OpenClawConfig {
  return {
    agents: {
      list: [{ id: "main", default: true }],
    },
    bindings: [{ agentId: "main", match: { channel: "telegram" } }],
  };
}

describe("agentsListCommand", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireValidConfigMock.mockResolvedValue(createConfig());
    buildProviderStatusIndexMock.mockResolvedValue(new Map());
  });

  it("keeps plain JSON output on the config-only path", async () => {
    const runtime = createRuntime();

    await agentsListCommand({ json: true }, runtime);

    expect(buildProviderStatusIndexMock).not.toHaveBeenCalled();
    const summary = (runtime.json[0] as Array<Record<string, unknown>>)[0];
    expect(summary).toMatchObject({ id: "main" });
    expect(summary).not.toHaveProperty("routes");
    expect(summary).not.toHaveProperty("providers");
  });

  it("keeps provider details available for JSON callers that request bindings", async () => {
    const runtime = createRuntime();

    await agentsListCommand({ json: true, bindings: true }, runtime);

    expect(buildProviderStatusIndexMock).toHaveBeenCalledOnce();
    expect(runtime.json[0]).toEqual([
      expect.objectContaining({
        id: "main",
        routes: ["Telegram default"],
        providers: ["Telegram default: configured"],
      }),
    ]);
  });
});
