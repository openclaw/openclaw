import { describe, expect, it } from "vitest";
import { getSlashCommands, parseCommand } from "./commands.js";
import {
  createBackspaceDeduper,
  resolveFinalAssistantText,
  resolveGatewayDisconnectState,
  resolveTuiSessionKey,
} from "./tui.js";

describe("resolveFinalAssistantText", () => {
  it("falls back to streamed text when final text is empty", () => {
    expect(resolveFinalAssistantText({ finalText: "", streamedText: "Hello" })).toBe("Hello");
  });

  it("prefers the final text when present", () => {
    expect(
      resolveFinalAssistantText({
        finalText: "All done",
        streamedText: "partial",
      }),
    ).toBe("All done");
  });
});

describe("tui slash commands", () => {
  it("treats /elev as an alias for /elevated", () => {
    expect(parseCommand("/elev on")).toEqual({ name: "elevated", args: "on" });
  });

  it("normalizes alias case", () => {
    expect(parseCommand("/ELEV off")).toEqual({
      name: "elevated",
      args: "off",
    });
  });

  it("includes gateway text commands", () => {
    const commands = getSlashCommands({});
    expect(commands.some((command) => command.name === "context")).toBe(true);
    expect(commands.some((command) => command.name === "commands")).toBe(true);
  });
});

describe("resolveTuiSessionKey", () => {
  it("uses global only as the default when scope is global", () => {
    expect(
      resolveTuiSessionKey({
        raw: "",
        sessionScope: "global",
        currentAgentId: "main",
        sessionMainKey: "agent:main:main",
      }),
    ).toBe("global");
    expect(
      resolveTuiSessionKey({
        raw: "test123",
        sessionScope: "global",
        currentAgentId: "main",
        sessionMainKey: "agent:main:main",
      }),
    ).toBe("agent:main:test123");
  });

  it("keeps explicit agent-prefixed keys unchanged", () => {
    expect(
      resolveTuiSessionKey({
        raw: "agent:ops:incident",
        sessionScope: "global",
        currentAgentId: "main",
        sessionMainKey: "agent:main:main",
      }),
    ).toBe("agent:ops:incident");
  });
});

describe("resolveGatewayDisconnectState", () => {
  it("returns pairing recovery guidance when disconnect reason requires pairing", () => {
    const state = resolveGatewayDisconnectState("gateway closed (1008): pairing required");
    expect(state.connectionStatus).toContain("pairing required");
    expect(state.activityStatus).toBe("pairing required: run openclaw devices list");
    expect(state.pairingHint).toContain("openclaw devices list");
  });

  it("falls back to idle for generic disconnect reasons", () => {
    const state = resolveGatewayDisconnectState("network timeout");
    expect(state.connectionStatus).toBe("gateway disconnected: network timeout");
    expect(state.activityStatus).toBe("idle");
    expect(state.pairingHint).toBeUndefined();
  });
});

describe("createBackspaceDeduper", () => {
  it("suppresses duplicate backspace events within the dedupe window", () => {
    let now = 1000;
    const dedupe = createBackspaceDeduper({
      dedupeWindowMs: 8,
      now: () => now,
    });

    expect(dedupe("\x7f")).toBe("\x7f");
    now += 1;
    expect(dedupe("\x08")).toBe("");
  });

  it("preserves backspace events outside the dedupe window", () => {
    let now = 1000;
    const dedupe = createBackspaceDeduper({
      dedupeWindowMs: 8,
      now: () => now,
    });

    expect(dedupe("\x7f")).toBe("\x7f");
    now += 10;
    expect(dedupe("\x7f")).toBe("\x7f");
  });

  it("never suppresses non-backspace keys", () => {
    const dedupe = createBackspaceDeduper();
    expect(dedupe("a")).toBe("a");
    expect(dedupe("\x1b[A")).toBe("\x1b[A");
  });
});
