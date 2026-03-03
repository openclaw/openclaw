import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { loadConfig, validateConfigObject } from "./config.js";
import { withTempHomeConfig } from "./test-helpers.js";

describe("multi-agent agentDir validation", () => {
  it("rejects shared agents.list agentDir", async () => {
    const shared = path.join(tmpdir(), "bot-shared-agentdir");
    const res = validateConfigObject({
      agents: {
        list: [
          { id: "a", agentDir: shared },
          { id: "b", agentDir: shared },
        ],
      },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issues.some((i) => i.path === "agents.list")).toBe(true);
      expect(res.issues[0]?.message).toContain("Duplicate agentDir");
    }
  });

  it("throws on shared agentDir during loadConfig()", async () => {
    await withTempHomeConfig(
      {
        agents: {
          list: [
            { id: "a", agentDir: "~/.hanzo/bot/agents/shared/agent" },
            { id: "b", agentDir: "~/.hanzo/bot/agents/shared/agent" },
          ],
        },
        bindings: [{ agentId: "a", match: { channel: "telegram" } }],
      },
      async () => {
        const spy = vi.spyOn(console, "error").mockImplementation(() => {});
        expect(() => loadConfig()).toThrow(/duplicate agentDir/i);
        expect(spy.mock.calls.flat().join(" ")).toMatch(/Duplicate agentDir/i);
        spy.mockRestore();
      },
    );
  });
});
