// Agents set-default tests cover atomic config reassignment and no-op/error paths.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { AgentsSchema } from "../config/zod-schema.agents.js";
import { baseConfigSnapshot, createTestRuntime } from "./test-runtime-config-helpers.js";

type ReplaceConfigParams = {
  nextConfig: OpenClawConfig;
  baseHash?: string;
};

const configMocks = vi.hoisted(() => ({
  readConfigFileSnapshot: vi.fn(),
  replaceConfigFile: vi.fn(async (_params: ReplaceConfigParams) => {}),
}));

vi.mock("../config/config.js", async () => ({
  ...(await vi.importActual<typeof import("../config/config.js")>("../config/config.js")),
  readConfigFileSnapshot: configMocks.readConfigFileSnapshot,
  replaceConfigFile: configMocks.replaceConfigFile,
}));

import { agentsSetDefaultCommand } from "./agents.commands.set-default.js";

const runtime = createTestRuntime();

function readJsonLog(): Record<string, unknown> {
  const message = runtime.log.mock.calls.at(-1)?.[0];
  if (typeof message !== "string") {
    throw new Error("expected JSON log output");
  }
  return JSON.parse(message) as Record<string, unknown>;
}

describe("agents set-default command", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reassigns the default marker in one validated config write", async () => {
    const config = {
      agents: {
        defaults: { workspace: "/workspace" },
        entries: {
          main: { default: true, name: "Main" },
          work: { name: "Work" },
          ops: { name: "Ops" },
        },
      },
    };
    configMocks.readConfigFileSnapshot.mockResolvedValue({
      ...baseConfigSnapshot,
      hash: "base-hash",
      config,
      sourceConfig: config,
    });

    await agentsSetDefaultCommand({ id: "work", json: true }, runtime);

    expect(configMocks.replaceConfigFile).toHaveBeenCalledOnce();
    const writeCall = configMocks.replaceConfigFile.mock.calls[0];
    if (!writeCall) {
      throw new Error("expected config write");
    }
    const [{ nextConfig, baseHash }] = writeCall;
    const nextAgents = nextConfig.agents;
    if (!nextAgents) {
      throw new Error("expected agents config");
    }
    expect(baseHash).toBe("base-hash");
    expect(nextAgents.entries).toEqual({
      main: { name: "Main" },
      work: { name: "Work", default: true },
      ops: { name: "Ops" },
    });
    expect(AgentsSchema.safeParse(nextAgents).success).toBe(true);
    expect(readJsonLog()).toEqual({ agentId: "work", changed: true });
  });

  it("errors without writing when the agent does not exist", async () => {
    const config = { agents: { entries: { main: { default: true } } } };
    configMocks.readConfigFileSnapshot.mockResolvedValue({
      ...baseConfigSnapshot,
      config,
      sourceConfig: config,
    });

    await agentsSetDefaultCommand({ id: "missing" }, runtime);

    expect(runtime.error).toHaveBeenCalledWith(
      'Agent "missing" not found. Run openclaw agents list to see configured agents.',
    );
    expect(runtime.exit).toHaveBeenCalledWith(1);
    expect(configMocks.replaceConfigFile).not.toHaveBeenCalled();
  });

  it("succeeds without writing when the agent is already default", async () => {
    const config = {
      agents: { entries: { main: { default: true }, work: { name: "Work" } } },
    };
    configMocks.readConfigFileSnapshot.mockResolvedValue({
      ...baseConfigSnapshot,
      config,
      sourceConfig: config,
    });

    await agentsSetDefaultCommand({ id: "main", json: true }, runtime);

    expect(configMocks.replaceConfigFile).not.toHaveBeenCalled();
    expect(runtime.exit).not.toHaveBeenCalled();
    expect(readJsonLog()).toEqual({ agentId: "main", changed: false });
  });
});
