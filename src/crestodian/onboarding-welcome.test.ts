import { describe, expect, it, vi } from "vitest";
import { buildOnboardingWelcome } from "./onboarding-welcome.js";

const mocks = vi.hoisted(() => ({
  sourceConfig: { agents: { defaults: { workspace: "/existing/workspace" } } },
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
});
