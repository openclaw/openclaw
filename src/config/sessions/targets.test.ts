import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withTempHome } from "../../../test/helpers/temp-home.js";
import type { OpenClawConfig } from "../config.js";
import {
  resolveAllAgentSessionStoreTargets,
  resolveAllAgentSessionStoreTargetsSync,
  resolveSessionStoreTargets,
} from "./targets.js";

async function resolveRealStorePath(sessionsDir: string): Promise<string> {
  return await fs.realpath(path.join(sessionsDir, "sessions.json"));
}

describe("resolveSessionStoreTargets", () => {
  it("resolves all configured agent stores", () => {
    const cfg: OpenClawConfig = {
      session: {
        store: "~/.openclaw/agents/{agentId}/sessions/sessions.json",
      },
      agents: {
        list: [{ id: "main", default: true }, { id: "work" }],
      },
    };

    const targets = resolveSessionStoreTargets(cfg, { allAgents: true });

    expect(targets).toEqual([
      {
        agentId: "main",
        storePath: path.resolve(
          path.join(process.env.HOME ?? "", ".openclaw/agents/main/sessions/sessions.json"),
        ),
      },
      {
        agentId: "work",
        storePath: path.resolve(
          path.join(process.env.HOME ?? "", ".openclaw/agents/work/sessions/sessions.json"),
        ),
      },
    ]);
  });

  it("dedupes shared store paths for --all-agents", () => {
    const cfg: OpenClawConfig = {
      session: {
        store: "/tmp/shared-sessions.json",
      },
      agents: {
        list: [{ id: "main", default: true }, { id: "work" }],
      },
    };

    expect(resolveSessionStoreTargets(cfg, { allAgents: true })).toEqual([
      { agentId: "main", storePath: path.resolve("/tmp/shared-sessions.json") },
    ]);
  });

  it("rejects unknown agent ids", () => {
    const cfg: OpenClawConfig = {
      agents: {
        list: [{ id: "main", default: true }, { id: "work" }],
      },
    };

    expect(() => resolveSessionStoreTargets(cfg, { agent: "ghost" })).toThrow(/Unknown agent id/);
  });

  it("rejects conflicting selectors", () => {
    expect(() => resolveSessionStoreTargets({}, { agent: "main", allAgents: true })).toThrow(
      /cannot be used together/i,
    );
    expect(() =>
      resolveSessionStoreTargets({}, { store: "/tmp/sessions.json", allAgents: true }),
    ).toThrow(/cannot be combined/i);
  });
});

describe("resolveAllAgentSessionStoreTargets", () => {
  it("includes discovered on-disk agent stores alongside configured targets", async () => {
    await withTempHome(async (home) => {
      const stateDir = path.join(home, ".openclaw");
      const opsSessionsDir = path.join(stateDir, "agents", "ops", "sessions");
      const retiredSessionsDir = path.join(stateDir, "agents", "retired", "sessions");
      await fs.mkdir(opsSessionsDir, { recursive: true });
      await fs.mkdir(retiredSessionsDir, { recursive: true });
      await fs.writeFile(path.join(opsSessionsDir, "sessions.json"), "{}", "utf8");
      await fs.writeFile(path.join(retiredSessionsDir, "sessions.json"), "{}", "utf8");

      const cfg: OpenClawConfig = {
        agents: {
          list: [{ id: "ops", default: true }],
        },
      };
      const opsStorePath = await resolveRealStorePath(opsSessionsDir);
      const retiredStorePath = await resolveRealStorePath(retiredSessionsDir);

      const targets = await resolveAllAgentSessionStoreTargets(cfg, { env: process.env });

      expect(targets).toEqual(
        expect.arrayContaining([
          {
            agentId: "ops",
            storePath: opsStorePath,
          },
          {
            agentId: "retired",
            storePath: retiredStorePath,
          },
        ]),
      );
      expect(targets.filter((target) => target.storePath === opsStorePath)).toHaveLength(1);
    });
  });

  it("discovers retired agent stores under a configured custom session root", async () => {
    await withTempHome(async (home) => {
      const customRoot = path.join(home, "custom-state");
      const opsSessionsDir = path.join(customRoot, "agents", "ops", "sessions");
      const retiredSessionsDir = path.join(customRoot, "agents", "retired", "sessions");
      await fs.mkdir(opsSessionsDir, { recursive: true });
      await fs.mkdir(retiredSessionsDir, { recursive: true });
      await fs.writeFile(path.join(opsSessionsDir, "sessions.json"), "{}", "utf8");
      await fs.writeFile(path.join(retiredSessionsDir, "sessions.json"), "{}", "utf8");

      const cfg: OpenClawConfig = {
        session: {
          store: path.join(customRoot, "agents", "{agentId}", "sessions", "sessions.json"),
        },
        agents: {
          list: [{ id: "ops", default: true }],
        },
      };
      const opsStorePath = await resolveRealStorePath(opsSessionsDir);
      const retiredStorePath = await resolveRealStorePath(retiredSessionsDir);

      const targets = await resolveAllAgentSessionStoreTargets(cfg, { env: process.env });

      expect(targets).toEqual(
        expect.arrayContaining([
          {
            agentId: "ops",
            storePath: opsStorePath,
          },
          {
            agentId: "retired",
            storePath: retiredStorePath,
          },
        ]),
      );
      expect(targets.filter((target) => target.storePath === opsStorePath)).toHaveLength(1);
    });
  });

  it("keeps the actual on-disk store path for discovered retired agents", async () => {
    await withTempHome(async (home) => {
      const customRoot = path.join(home, "custom-state");
      const opsSessionsDir = path.join(customRoot, "agents", "ops", "sessions");
      const retiredSessionsDir = path.join(customRoot, "agents", "Retired Agent", "sessions");
      await fs.mkdir(opsSessionsDir, { recursive: true });
      await fs.mkdir(retiredSessionsDir, { recursive: true });
      await fs.writeFile(path.join(opsSessionsDir, "sessions.json"), "{}", "utf8");
      await fs.writeFile(path.join(retiredSessionsDir, "sessions.json"), "{}", "utf8");

      const cfg: OpenClawConfig = {
        session: {
          store: path.join(customRoot, "agents", "{agentId}", "sessions", "sessions.json"),
        },
        agents: {
          list: [{ id: "ops", default: true }],
        },
      };
      const retiredStorePath = await resolveRealStorePath(retiredSessionsDir);

      const targets = await resolveAllAgentSessionStoreTargets(cfg, { env: process.env });

      expect(targets).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            agentId: "retired-agent",
            storePath: retiredStorePath,
          }),
        ]),
      );
    });
  });

  it("respects the caller env when resolving configured and discovered store roots", async () => {
    await withTempHome(async (home) => {
      const envStateDir = path.join(home, "env-state");
      const mainSessionsDir = path.join(envStateDir, "agents", "main", "sessions");
      const retiredSessionsDir = path.join(envStateDir, "agents", "retired", "sessions");
      await fs.mkdir(mainSessionsDir, { recursive: true });
      await fs.mkdir(retiredSessionsDir, { recursive: true });
      await fs.writeFile(path.join(mainSessionsDir, "sessions.json"), "{}", "utf8");
      await fs.writeFile(path.join(retiredSessionsDir, "sessions.json"), "{}", "utf8");

      const env = {
        ...process.env,
        OPENCLAW_STATE_DIR: envStateDir,
      };
      const cfg: OpenClawConfig = {};
      const mainStorePath = await resolveRealStorePath(mainSessionsDir);
      const retiredStorePath = await resolveRealStorePath(retiredSessionsDir);

      const targets = await resolveAllAgentSessionStoreTargets(cfg, { env });

      expect(targets).toEqual(
        expect.arrayContaining([
          {
            agentId: "main",
            storePath: mainStorePath,
          },
          {
            agentId: "retired",
            storePath: retiredStorePath,
          },
        ]),
      );
    });
  });

  it("skips unreadable or invalid discovery roots when other roots are still readable", async () => {
    await withTempHome(async (home) => {
      const customRoot = path.join(home, "custom-state");
      await fs.mkdir(customRoot, { recursive: true });
      await fs.writeFile(path.join(customRoot, "agents"), "not-a-directory", "utf8");

      const envStateDir = path.join(home, "env-state");
      const mainSessionsDir = path.join(envStateDir, "agents", "main", "sessions");
      const retiredSessionsDir = path.join(envStateDir, "agents", "retired", "sessions");
      await fs.mkdir(mainSessionsDir, { recursive: true });
      await fs.mkdir(retiredSessionsDir, { recursive: true });
      await fs.writeFile(path.join(mainSessionsDir, "sessions.json"), "{}", "utf8");
      await fs.writeFile(path.join(retiredSessionsDir, "sessions.json"), "{}", "utf8");

      const cfg: OpenClawConfig = {
        session: {
          store: path.join(customRoot, "agents", "{agentId}", "sessions", "sessions.json"),
        },
        agents: {
          list: [{ id: "main", default: true }],
        },
      };
      const env = {
        ...process.env,
        OPENCLAW_STATE_DIR: envStateDir,
      };
      const retiredStorePath = await resolveRealStorePath(retiredSessionsDir);

      await expect(resolveAllAgentSessionStoreTargets(cfg, { env })).resolves.toEqual(
        expect.arrayContaining([
          {
            agentId: "retired",
            storePath: retiredStorePath,
          },
        ]),
      );
    });
  });

  it("skips symlinked discovered stores under templated agents roots", async () => {
    await withTempHome(async (home) => {
      if (process.platform === "win32") {
        return;
      }
      const customRoot = path.join(home, "custom-state");
      const opsSessionsDir = path.join(customRoot, "agents", "ops", "sessions");
      const leakedFile = path.join(home, "outside.json");
      await fs.mkdir(opsSessionsDir, { recursive: true });
      await fs.writeFile(leakedFile, JSON.stringify({ leak: { secret: "x" } }), "utf8");
      await fs.symlink(leakedFile, path.join(opsSessionsDir, "sessions.json"));

      const cfg: OpenClawConfig = {
        session: {
          store: path.join(customRoot, "agents", "{agentId}", "sessions", "sessions.json"),
        },
        agents: {
          list: [{ id: "ops", default: true }],
        },
      };

      const targets = await resolveAllAgentSessionStoreTargets(cfg, { env: process.env });
      expect(targets).not.toContainEqual({
        agentId: "ops",
        storePath: expect.stringContaining(path.join("ops", "sessions", "sessions.json")),
      });
    });
  });

  it("skips discovered directories that only normalize into the default main agent", async () => {
    await withTempHome(async (home) => {
      const stateDir = path.join(home, ".openclaw");
      const mainSessionsDir = path.join(stateDir, "agents", "main", "sessions");
      const junkSessionsDir = path.join(stateDir, "agents", "###", "sessions");
      await fs.mkdir(mainSessionsDir, { recursive: true });
      await fs.mkdir(junkSessionsDir, { recursive: true });
      await fs.writeFile(path.join(mainSessionsDir, "sessions.json"), "{}", "utf8");
      await fs.writeFile(path.join(junkSessionsDir, "sessions.json"), "{}", "utf8");

      const cfg: OpenClawConfig = {};
      const mainStorePath = await resolveRealStorePath(mainSessionsDir);
      const targets = await resolveAllAgentSessionStoreTargets(cfg, { env: process.env });

      expect(targets).toContainEqual({
        agentId: "main",
        storePath: mainStorePath,
      });
      expect(
        targets.some((target) => target.storePath === path.join(junkSessionsDir, "sessions.json")),
      ).toBe(false);
    });
  });
});

describe("resolveAllAgentSessionStoreTargetsSync", () => {
  it("skips unreadable or invalid discovery roots when other roots are still readable", async () => {
    await withTempHome(async (home) => {
      const customRoot = path.join(home, "custom-state");
      await fs.mkdir(customRoot, { recursive: true });
      await fs.writeFile(path.join(customRoot, "agents"), "not-a-directory", "utf8");

      const envStateDir = path.join(home, "env-state");
      const mainSessionsDir = path.join(envStateDir, "agents", "main", "sessions");
      const retiredSessionsDir = path.join(envStateDir, "agents", "retired", "sessions");
      await fs.mkdir(mainSessionsDir, { recursive: true });
      await fs.mkdir(retiredSessionsDir, { recursive: true });
      await fs.writeFile(path.join(mainSessionsDir, "sessions.json"), "{}", "utf8");
      await fs.writeFile(path.join(retiredSessionsDir, "sessions.json"), "{}", "utf8");

      const cfg: OpenClawConfig = {
        session: {
          store: path.join(customRoot, "agents", "{agentId}", "sessions", "sessions.json"),
        },
        agents: {
          list: [{ id: "main", default: true }],
        },
      };
      const env = {
        ...process.env,
        OPENCLAW_STATE_DIR: envStateDir,
      };
      const retiredStorePath = await resolveRealStorePath(retiredSessionsDir);

      expect(resolveAllAgentSessionStoreTargetsSync(cfg, { env })).toEqual(
        expect.arrayContaining([
          {
            agentId: "retired",
            storePath: retiredStorePath,
          },
        ]),
      );
    });
  });

  it("skips symlinked discovered stores under templated agents roots", async () => {
    await withTempHome(async (home) => {
      if (process.platform === "win32") {
        return;
      }
      const customRoot = path.join(home, "custom-state");
      const opsSessionsDir = path.join(customRoot, "agents", "ops", "sessions");
      const leakedFile = path.join(home, "outside.json");
      await fs.mkdir(opsSessionsDir, { recursive: true });
      await fs.writeFile(leakedFile, JSON.stringify({ leak: { secret: "x" } }), "utf8");
      await fs.symlink(leakedFile, path.join(opsSessionsDir, "sessions.json"));

      const cfg: OpenClawConfig = {
        session: {
          store: path.join(customRoot, "agents", "{agentId}", "sessions", "sessions.json"),
        },
        agents: {
          list: [{ id: "ops", default: true }],
        },
      };

      const targets = resolveAllAgentSessionStoreTargetsSync(cfg, { env: process.env });
      expect(targets).not.toContainEqual({
        agentId: "ops",
        storePath: expect.stringContaining(path.join("ops", "sessions", "sessions.json")),
      });
    });
  });
});
