import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeEnv } from "../runtime.js";

vi.mock("./agents.command-shared.js", () => ({
  requireValidConfig: vi.fn(),
}));

vi.mock("./agents.providers.js", () => ({
  buildProviderStatusIndex: vi.fn(async () => new Map()),
  listProvidersForAgent: vi.fn(() => []),
  summarizeBindings: vi.fn(() => []),
}));

import { requireValidConfig } from "./agents.command-shared.js";
import { agentsListCommand } from "./agents.commands.list.js";

function createRuntime(): RuntimeEnv {
  return {
    log: vi.fn(),
  } as unknown as RuntimeEnv;
}

describe("agentsListCommand", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("includes execBlocked/toolDeny/sandbox fields in --json output", async () => {
    vi.mocked(requireValidConfig).mockResolvedValue({
      agents: {
        defaults: {
          model: "anthropic/claude-sonnet-4-6",
          sandbox: { mode: "off" },
        },
        list: [
          {
            id: "ada",
            name: "Ada",
            model: "openai-codex/gpt-5.3-codex",
            sandbox: { mode: "off" },
            tools: {
              sandbox: {
                tools: {
                  deny: ["group:runtime"],
                },
              },
            },
          },
        ],
      },
    } as never);
    const runtime = createRuntime();

    await agentsListCommand({ json: true }, runtime);

    expect(runtime.log).toHaveBeenCalledTimes(1);
    const firstLogArg = vi.mocked(runtime.log).mock.calls[0]?.[0];
    expect(typeof firstLogArg).toBe("string");
    const payload = JSON.parse((firstLogArg as string | undefined) ?? "[]") as Array<
      Record<string, unknown>
    >;
    expect(payload).toHaveLength(1);
    expect(payload[0]).toMatchObject({
      id: "ada",
      toolDeny: ["group:runtime"],
      execBlocked: true,
      sandbox: {
        mode: "off",
        scope: "agent",
      },
    });
  });

  it("renders tool and sandbox status in text output", async () => {
    vi.mocked(requireValidConfig).mockResolvedValue({
      agents: {
        defaults: {
          model: "anthropic/claude-sonnet-4-6",
          sandbox: { mode: "off" },
        },
        list: [
          {
            id: "ada",
            name: "Ada",
            model: "openai-codex/gpt-5.3-codex",
            sandbox: { mode: "off" },
            tools: {
              sandbox: {
                tools: {
                  deny: ["group:runtime"],
                },
              },
            },
          },
        ],
      },
    } as never);
    const runtime = createRuntime();

    await agentsListCommand({}, runtime);

    const firstLogArg = vi.mocked(runtime.log).mock.calls[0]?.[0];
    expect(typeof firstLogArg).toBe("string");
    const output = (firstLogArg as string | undefined) ?? "";
    expect(output).toContain("Tools: exec blocked (group:runtime denied)");
    expect(output).toContain("Sandbox: off (scope: agent)");
  });
});
