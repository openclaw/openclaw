import { describe, expect, it, vi } from "vitest";
import { resolveSandboxContext } from "../../agents/sandbox/context.js";

vi.mock("../../agents/sandbox/runtime-status.js", () => ({
  resolveSandboxRuntimeStatus: vi.fn(() => ({
    sandboxed: false,
    mode: "off",
    agentId: "main",
    sessionKey: "agent:main:cron:test",
    mainSessionKey: "agent:main:main",
    toolPolicy: { allow: [], deny: [], sources: { allow: { key: "" }, deny: { key: "" } } },
  })),
}));

vi.mock("../../agents/sandbox/backend.js", () => ({
  requireSandboxBackendFactory: vi.fn(() => {
    throw new Error("failed to connect to the docker API");
  }),
}));

describe("isolated session docker probe regression (#73586)", () => {
  it("does not touch docker backend when sandbox mode is off", async () => {
    const result = await resolveSandboxContext({
      config: {
        agents: {
          defaults: {
            sandbox: {
              mode: "off",
            },
          },
        },
      } as never,
      sessionKey: "agent:main:cron:test",
      workspaceDir: "/tmp/workspace",
    });
    expect(result).toBeNull();
  });
});
