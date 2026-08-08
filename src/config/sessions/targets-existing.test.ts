import fs from "node:fs/promises";
import path from "node:path";
import { withTempHome } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config.js";
import { resolveStorePath } from "./paths.js";
import { replaceSessionEntry } from "./session-accessor.js";
import {
  resolveAllAgentSessionStoreTargetsSync,
  resolveExistingAgentSessionStoreTargetsSync,
} from "./targets.js";

function createCustomRootCfg(customRoot: string, defaultAgentId = "ops"): OpenClawConfig {
  return {
    session: {
      store: path.join(customRoot, "agents", "{agentId}", "sessions", "sessions.json"),
    },
    agents: {
      list: [{ id: defaultAgentId, default: true }],
    },
  };
}

describe("resolveExistingAgentSessionStoreTargetsSync", () => {
  it("requires agent-specific rows instead of fixed-store file existence", async () => {
    await withTempHome(async (home) => {
      const storePath = path.join(home, "shared", "sessions.json");
      await fs.mkdir(path.dirname(storePath), { recursive: true });
      await fs.writeFile(storePath, "{}\n", "utf8");
      const cfg: OpenClawConfig = {
        agents: { list: [{ id: "main", default: true }] },
        session: { store: storePath },
      };

      expect(resolveExistingAgentSessionStoreTargetsSync(cfg, "ghost")).toEqual([]);

      await replaceSessionEntry(
        { agentId: "ghost", sessionKey: "agent:ghost:existing", storePath },
        { sessionId: "session-ghost", updatedAt: 42 },
      );

      expect(resolveExistingAgentSessionStoreTargetsSync(cfg, "ghost")).toEqual([
        { agentId: "ghost", storePath },
      ]);
    });
  });

  it("ignores matching rows in a fixed legacy store without creating SQLite", async () => {
    await withTempHome(async (home) => {
      const storePath = path.join(home, "shared", "sessions.json");
      await fs.mkdir(path.dirname(storePath), { recursive: true });
      await fs.writeFile(
        storePath,
        JSON.stringify({
          "agent:retired:existing": { sessionId: "legacy-retired", updatedAt: 42 },
          "agent:other:existing": { sessionId: "legacy-other", updatedAt: 41 },
        }),
        "utf8",
      );
      const cfg: OpenClawConfig = {
        agents: { list: [{ id: "main", default: true }] },
        session: { store: storePath },
      };

      expect(resolveExistingAgentSessionStoreTargetsSync(cfg, "retired")).toEqual([]);
      expect(resolveExistingAgentSessionStoreTargetsSync(cfg, "ghost")).toEqual([]);
      expect(await fs.readdir(path.dirname(storePath))).toEqual(["sessions.json"]);
    });
  });

  it("includes existing deterministic template targets outside discoverable agent roots", async () => {
    await withTempHome(async (home) => {
      const storeTemplate = path.join(home, "external-stores", "sessions-{agentId}.json");
      const cfg: OpenClawConfig = {
        agents: { list: [{ id: "main", default: true }] },
        session: { store: storeTemplate },
      };
      const legacyStorePath = resolveStorePath(storeTemplate, { agentId: "retired-legacy" });
      const sqliteStorePath = resolveStorePath(storeTemplate, { agentId: "retired-sqlite" });
      await fs.mkdir(path.dirname(legacyStorePath), { recursive: true });
      await fs.writeFile(
        legacyStorePath,
        JSON.stringify({
          "agent:retired-legacy:existing": { sessionId: "legacy-retired", updatedAt: 42 },
        }),
        "utf8",
      );
      await replaceSessionEntry(
        {
          agentId: "retired-sqlite",
          sessionKey: "agent:retired-sqlite:existing",
          storePath: sqliteStorePath,
        },
        { sessionId: "sqlite-retired", updatedAt: 42 },
      );

      expect(resolveAllAgentSessionStoreTargetsSync(cfg)).not.toContainEqual({
        agentId: "retired-legacy",
        storePath: legacyStorePath,
      });
      expect(resolveAllAgentSessionStoreTargetsSync(cfg)).not.toContainEqual({
        agentId: "retired-sqlite",
        storePath: sqliteStorePath,
      });
      expect(resolveExistingAgentSessionStoreTargetsSync(cfg, "retired-legacy")).toEqual([]);
      expect(resolveExistingAgentSessionStoreTargetsSync(cfg, "retired-sqlite")).toEqual([
        { agentId: "retired-sqlite", storePath: sqliteStorePath },
      ]);
      expect(resolveExistingAgentSessionStoreTargetsSync(cfg, "ghost")).toEqual([]);
    });
  });

  it("rejects a deterministic target whose store symlink escapes the agents root", async () => {
    await withTempHome(async (home) => {
      if (process.platform === "win32") {
        return;
      }
      const customRoot = path.join(home, "custom-state");
      const escapedSessionsDir = path.join(customRoot, "agents", "escaped", "sessions");
      const outsideStorePath = path.join(home, "outside-sessions.json");
      const escapedStorePath = path.join(escapedSessionsDir, "sessions.json");
      await fs.mkdir(escapedSessionsDir, { recursive: true });
      await fs.writeFile(
        outsideStorePath,
        JSON.stringify({
          "agent:escaped:secret": { sessionId: "outside-session", updatedAt: 42 },
        }),
        "utf8",
      );
      await fs.symlink(outsideStorePath, escapedStorePath);

      const cfg = createCustomRootCfg(customRoot, "main");
      expect(resolveAllAgentSessionStoreTargetsSync(cfg)).not.toContainEqual({
        agentId: "escaped",
        storePath: escapedStorePath,
      });
      expect(resolveExistingAgentSessionStoreTargetsSync(cfg, "escaped")).toEqual([]);
    });
  });
});
