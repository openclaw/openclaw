// Combined gateway session-store tests cover multi-agent loading decisions.
import fs from "node:fs/promises";
import path from "node:path";
import { withTempHome } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../types.openclaw.js";
import { loadCombinedSessionStoreForGateway } from "./combined-store-gateway.js";

async function writeStore(storePath: string, store: Record<string, unknown>): Promise<void> {
  await fs.mkdir(path.dirname(storePath), { recursive: true });
  await fs.writeFile(storePath, JSON.stringify(store), "utf8");
}

describe("loadCombinedSessionStoreForGateway", () => {
  it("discovers sibling agent stores for literal agent-tree session stores (#54435)", async () => {
    await withTempHome(async (home) => {
      const customRoot = path.join(home, "custom-state");
      const mainStorePath = path.join(customRoot, "agents", "main", "sessions", "sessions.json");
      const codexStorePath = path.join(customRoot, "agents", "codex", "sessions", "sessions.json");

      await writeStore(mainStorePath, {
        "agent:main:main": { sessionId: "s-main", updatedAt: 100 },
      });
      await writeStore(codexStorePath, {
        main: { sessionId: "s-codex-main", updatedAt: 200 },
        "agent:codex:acp-task": { sessionId: "s-codex", updatedAt: 150 },
      });
      await writeStore(
        path.join(home, ".openclaw", "agents", "other", "sessions", "sessions.json"),
        {
          "agent:other:leaked": { sessionId: "s-leaked", updatedAt: 300 },
        },
      );

      const cfg: OpenClawConfig = {
        session: {
          mainKey: "main",
          store: mainStorePath,
        },
        agents: {
          list: [{ id: "main", default: true }],
        },
      };

      const { store, storePath } = loadCombinedSessionStoreForGateway(cfg);

      expect(storePath).toBe(mainStorePath);
      expect(Object.keys(store).toSorted()).toEqual([
        "agent:codex:acp-task",
        "agent:codex:main",
        "agent:main:main",
      ]);
      expect(store["agent:codex:main"]?.sessionId).toBe("s-codex-main");
      expect(store["agent:main:main"]?.sessionId).toBe("s-main");
      expect(store["agent:other:leaked"]).toBeUndefined();
    });
  });

  it("keeps true shared literal session stores on the single-store path", async () => {
    await withTempHome(async (home) => {
      const sharedStorePath = path.join(home, "sessions.json");
      const siblingStorePath = path.join(home, "agents", "codex", "sessions", "sessions.json");

      await writeStore(sharedStorePath, {
        "agent:main:main": { sessionId: "s-main", updatedAt: 100 },
      });
      await writeStore(siblingStorePath, {
        "agent:codex:acp-task": { sessionId: "s-codex", updatedAt: 200 },
      });

      const cfg: OpenClawConfig = {
        session: {
          mainKey: "main",
          store: sharedStorePath,
        },
        agents: {
          list: [{ id: "main", default: true }],
        },
      };

      const { store, storePath } = loadCombinedSessionStoreForGateway(cfg);

      expect(storePath).toBe(sharedStorePath);
      expect(Object.keys(store)).toEqual(["agent:main:main"]);
    });
  });
});
