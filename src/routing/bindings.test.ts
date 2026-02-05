import * as fs from "node:fs";
import * as os from "node:os";
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { listBindings, resetBindingsCacheForTest } from "./bindings.js";

// Mock debug
const debugMock = vi.fn();
vi.mock("debug", () => ({
  default: () => debugMock,
}));

// Mock os
vi.mock("node:os", () => ({
  default: {
    homedir: () => "/mock/home",
  },
  homedir: () => "/mock/home",
}));

// Mock fs
vi.mock("node:fs", () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
}));

describe("bindings", () => {
  const mockConfig = { bindings: [] } as unknown as OpenClawConfig;

  beforeEach(() => {
    vi.clearAllMocks();
    resetBindingsCacheForTest();
  });

  it("should load valid bindings from routing.json", () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify([
        { agentId: "agent1", match: { channel: "telegram" } },
        { agentId: "agent2", match: { channel: "whatsapp", accountId: "123" } },
      ]),
    );

    const bindings = listBindings(mockConfig);
    expect(bindings).toHaveLength(2);
    expect(bindings[0].agentId).toBe("agent1");
    expect(bindings[1].match.accountId).toBe("123");
  });

  it("should filter invalid bindings", () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify([
        { agentId: "valid", match: { channel: "telegram" } },
        { agentId: "invalid_no_match" },
        { match: { channel: "invalid_no_agentId" } },
        { agentId: "invalid_bad_match_type", match: "not_object" },
      ]),
    );

    const bindings = listBindings(mockConfig);
    expect(bindings).toHaveLength(1);
    expect(bindings[0].agentId).toBe("valid");
    expect(debugMock).toHaveBeenCalled();
  });

  it("should handle invalid json gracefully", () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue("invalid-json");

    const bindings = listBindings(mockConfig);
    expect(bindings).toHaveLength(0);
    expect(debugMock).toHaveBeenCalled();
  });

  it("should handle missing file gracefully", () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);

    const bindings = listBindings(mockConfig);
    expect(bindings).toHaveLength(0);
  });
});
