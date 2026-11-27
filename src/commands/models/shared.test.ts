// Model command shared tests cover shared config and provider helper behavior.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { loadValidConfigSnapshotOrThrow, resolveModelsTargetAgent } from "./shared.js";

const mocks = vi.hoisted(() => ({
  readConfigFileSnapshot: vi.fn(),
}));

vi.mock("../../config/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../config/config.js")>()),
  readConfigFileSnapshot: (...args: unknown[]) => mocks.readConfigFileSnapshot(...args),
}));

describe("models/shared", () => {
  beforeEach(() => {
    mocks.readConfigFileSnapshot.mockClear();
  });

  it("returns the paired source and runtime config when the snapshot is valid", async () => {
    const cfg: OpenClawConfig = { logging: { level: "debug" } };
    const snapshot = {
      valid: true,
      sourceConfig: {},
      runtimeConfig: cfg,
    };
    mocks.readConfigFileSnapshot.mockResolvedValue(snapshot);

    await expect(loadValidConfigSnapshotOrThrow()).resolves.toEqual(snapshot);
  });

  it("throws formatted issues when snapshot is invalid", async () => {
    mocks.readConfigFileSnapshot.mockResolvedValue({
      valid: false,
      path: "/tmp/openclaw.json",
      issues: [{ path: "providers.openai.apiKey", message: "Required" }],
    });

    await expect(loadValidConfigSnapshotOrThrow()).rejects.toThrowError(
      "Invalid config at /tmp/openclaw.json\n- providers.openai.apiKey: Required",
    );
  });

  it("resolves unscoped model reads through the configured system agent", () => {
    const cfg: OpenClawConfig = {
      agents: {
        ownership: "explicit",
        defaults: { systemAgent: { agentId: "helper" } },
        entries: { main: {}, helper: {} },
      },
    };

    expect(resolveModelsTargetAgent(cfg, undefined, { kind: "read" }).agentId).toBe("helper");
    expect(resolveModelsTargetAgent(cfg, "main", { kind: "read" }).agentId).toBe("main");
    expect(() => resolveModelsTargetAgent(cfg, "", { kind: "read" })).toThrow(
      "--agent must not be blank",
    );
    expect(() =>
      resolveModelsTargetAgent(
        {
          agents: {
            ownership: "explicit",
            defaults: { systemAgent: { agentId: "missing" } },
            entries: { main: {}, helper: {} },
          },
        },
        undefined,
        { kind: "read" },
      ),
    ).toThrow('Unknown agent id "missing".');
  });

  it("keeps credential mutations explicit on an ambiguous roster", () => {
    expect(() =>
      resolveModelsTargetAgent(
        { agents: { ownership: "explicit", entries: { main: {}, helper: {} } } },
        undefined,
        { kind: "mutation" },
      ),
    ).toThrow(
      "Multiple agents are configured, but the model command has no explicit owner. Pass --agent <id>.",
    );
  });
});
