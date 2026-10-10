// Covers voice wake routing normalization and resolution.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readConfigMachineState } from "../state/config-machine-state.js";
import { loadVoiceWakeRoutingConfig, resolveVoiceWakeRouteByTrigger } from "./voicewake-routing.js";

vi.mock("../state/config-machine-state.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../state/config-machine-state.js")>()),
  readConfigMachineState: vi.fn(),
}));

beforeEach(() => {
  vi.mocked(readConfigMachineState).mockReset();
});

describe("voicewake routing normalization", () => {
  it("normalizes agentId targets from persisted routes", async () => {
    vi.mocked(readConfigMachineState).mockReturnValue({
      defaultTarget: { mode: "current" },
      routes: [{ trigger: "Wake", target: { agentId: " Main Agent " } }],
    });
    const normalized = await loadVoiceWakeRoutingConfig();
    expect(normalized.routes).toHaveLength(1);
    expect(normalized.routes[0]?.target).toEqual({ agentId: "main-agent" });
  });

  it("resolves trigger routing with punctuation-insensitive trigger values", async () => {
    vi.mocked(readConfigMachineState).mockReturnValue({
      defaultTarget: { mode: "current" },
      routes: [{ trigger: "Hey, Bot", target: { sessionKey: "agent:main:voice" } }],
    });
    const config = await loadVoiceWakeRoutingConfig();
    expect(resolveVoiceWakeRouteByTrigger({ trigger: "hey bot", config })).toEqual({
      sessionKey: "agent:main:voice",
    });
  });
});
