import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { listBindings, resetBindingsCacheForTest } from "./bindings.js";

/** Write a routing.json file in the test HOME */
function writeRoutingJson(content: string): void {
  const dir = path.join(os.homedir(), ".openclaw");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "routing.json"), content, "utf-8");
}

function removeRoutingJson(): void {
  const file = path.join(os.homedir(), ".openclaw", "routing.json");
  try {
    fs.unlinkSync(file);
  } catch {
    // ignore if missing
  }
}

describe("bindings", () => {
  const mockConfig = { bindings: [] } as unknown as OpenClawConfig;

  beforeEach(() => {
    resetBindingsCacheForTest();
    removeRoutingJson();
  });

  it("should load valid bindings from routing.json", () => {
    writeRoutingJson(
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
    writeRoutingJson(
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
  });

  it("should handle invalid json gracefully", () => {
    writeRoutingJson("invalid-json");

    const bindings = listBindings(mockConfig);
    expect(bindings).toHaveLength(0);
  });

  it("should handle missing file gracefully", () => {
    removeRoutingJson();

    const bindings = listBindings(mockConfig);
    expect(bindings).toHaveLength(0);
  });
});
