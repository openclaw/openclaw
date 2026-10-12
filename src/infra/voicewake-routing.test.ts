// Covers voice wake routing normalization and resolution.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readVoiceWakeMachineState } from "../state/config-machine-state-async.js";
import { loadVoiceWakeRoutingConfig, resolveVoiceWakeRouteByTrigger } from "./voicewake-routing.js";

vi.mock("../state/config-machine-state-async.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../state/config-machine-state-async.js")>()),
  readVoiceWakeMachineState: vi.fn(),
}));

beforeEach(() => {
  vi.mocked(readVoiceWakeMachineState).mockReset();
});

describe("voicewake routing normalization", () => {
  it("normalizes agentId targets from persisted routes", async () => {
    vi.mocked(readVoiceWakeMachineState).mockResolvedValue({
      updatedAtMs: 0,
      value: {
        defaultTarget: { mode: "current" },
        routes: [{ trigger: "Wake", target: { agentId: " Main Agent " } }],
      },
    });
    const normalized = await loadVoiceWakeRoutingConfig();
    expect(normalized.routes).toHaveLength(1);
    expect(normalized.routes[0]?.target).toEqual({ agentId: "main-agent" });
  });

  it("resolves trigger routing with punctuation-insensitive trigger values", async () => {
    vi.mocked(readVoiceWakeMachineState).mockResolvedValue({
      updatedAtMs: 0,
      value: {
        defaultTarget: { mode: "current" },
        routes: [{ trigger: "Hey, Bot", target: { sessionKey: "agent:main:voice" } }],
      },
    });
    const config = await loadVoiceWakeRoutingConfig();
    expect(resolveVoiceWakeRouteByTrigger({ trigger: "hey bot", config })).toEqual({
      sessionKey: "agent:main:voice",
    });
  });
});
