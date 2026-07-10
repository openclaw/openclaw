import { describe, expect, it, vi } from "vitest";
import { buildOnboardingWelcome } from "./onboarding-welcome.js";

const mocks = vi.hoisted(() => ({
  sourceConfig: {
    agents: { defaults: { workspace: "/existing/workspace" } },
    gateway: undefined as
      | {
          auth?: {
            mode?: string;
            token?: string | { source: "env"; provider: string; id: string };
          };
        }
      | undefined,
  },
}));

vi.mock("../config/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config/config.js")>()),
  readConfigFileSnapshot: vi.fn(async () => ({
    exists: true,
    valid: true,
    path: "/tmp/openclaw.json",
    hash: "hash",
    config: {},
    sourceConfig: mocks.sourceConfig,
    issues: [],
  })),
}));

vi.mock("../commands/onboard-inference.js", () => ({
  detectInferenceBackends: vi.fn(async () => []),
}));

vi.mock("../commands/onboard-helpers.js", () => ({ DEFAULT_WORKSPACE: "/default/workspace" }));

describe("buildOnboardingWelcome", () => {
  it("preserves an authored workspace in a partial setup", async () => {
    mocks.sourceConfig.agents.defaults.workspace = "/existing/workspace";
    const propose = vi.fn();
    const noteAssistantMessage = vi.fn();
    const engine = {
      loadOverview: vi.fn(async () => ({
        config: {
          path: "/tmp/openclaw.json",
          exists: true,
          valid: true,
          issues: [],
          hash: "hash",
        },
        defaultModel: undefined,
      })),
      propose,
      noteAssistantMessage,
    };

    const welcome = await buildOnboardingWelcome({ engine: engine as never });

    expect(propose).toHaveBeenCalledWith({ kind: "setup", workspace: "/existing/workspace" });
    expect(welcome).toContain("Workspace: /existing/workspace");
    expect(welcome).toContain("configure a model provider with masked credential prompts");
  });

  it("ignores a blank authored workspace", async () => {
    mocks.sourceConfig.agents.defaults.workspace = "   ";
    const propose = vi.fn();
    const engine = {
      loadOverview: vi.fn(async () => ({
        config: {
          path: "/tmp/openclaw.json",
          exists: true,
          valid: true,
          issues: [],
          hash: "hash",
        },
        defaultModel: undefined,
      })),
      propose,
      noteAssistantMessage: vi.fn(),
    };

    await buildOnboardingWelcome({ engine: engine as never });

    expect(propose).toHaveBeenCalledWith({ kind: "setup", workspace: "/default/workspace" });
  });

  it.each([
    { label: "blank token", auth: { token: "   " }, configured: false },
    {
      label: "SecretRef token",
      auth: { token: { source: "env" as const, provider: "default", id: "GATEWAY_TOKEN" } },
      configured: true,
    },
  ])("treats $label consistently with the app gate", async ({ auth, configured }) => {
    mocks.sourceConfig.gateway = { auth };
    const propose = vi.fn();
    const welcome = await buildOnboardingWelcome({
      engine: {
        loadOverview: vi.fn(async () => ({
          config: {
            path: "/tmp/openclaw.json",
            exists: true,
            valid: true,
            issues: [],
            hash: "hash",
          },
          defaultModel: "openai/gpt-5.5",
          gateway: { reachable: true, url: "ws://127.0.0.1:18789" },
        })),
        propose,
        noteAssistantMessage: vi.fn(),
      } as never,
    });

    expect(propose).toHaveBeenCalledTimes(configured ? 0 : 1);
    expect(welcome.includes("Say **yes**")).toBe(!configured);
  });
});
