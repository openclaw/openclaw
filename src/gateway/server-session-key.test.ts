import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { resetAgentRunContextForTest } from "../infra/agent-events.js";
import { withStateDirEnv } from "../test-helpers/state-dir-env.js";

const loadConfigMock = vi.hoisted(() => vi.fn<() => OpenClawConfig>());

vi.mock("../config/config.js", () => ({
  loadConfig: () => loadConfigMock(),
}));

const { resolveSessionKeyForRun } = await import("./server-session-key.js");

describe("resolveSessionKeyForRun", () => {
  beforeEach(() => {
    loadConfigMock.mockReset();
    resetAgentRunContextForTest();
  });

  afterEach(() => {
    resetAgentRunContextForTest();
  });

  it("finds run ids in disk-only agent stores under a custom session root", async () => {
    await withStateDirEnv("openclaw-run-key-", async ({ stateDir }) => {
      const customRoot = path.join(stateDir, "custom-state");
      const retiredSessionsDir = path.join(customRoot, "agents", "retired", "sessions");
      fs.mkdirSync(retiredSessionsDir, { recursive: true });
      fs.writeFileSync(
        path.join(retiredSessionsDir, "sessions.json"),
        JSON.stringify({
          "agent:retired:acp:run-1": { sessionId: "run-1", updatedAt: 123 },
        }),
        "utf8",
      );

      loadConfigMock.mockReturnValue({
        session: {
          store: path.join(customRoot, "agents", "{agentId}", "sessions", "sessions.json"),
        },
        agents: {
          list: [{ id: "main", default: true }],
        },
      });

      expect(resolveSessionKeyForRun("run-1")).toBe("acp:run-1");

      fs.rmSync(customRoot, { recursive: true, force: true });
      expect(resolveSessionKeyForRun("run-1")).toBe("acp:run-1");
    });
  });
});
