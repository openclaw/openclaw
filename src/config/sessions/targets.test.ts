import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withTempHome } from "../../../test/helpers/temp-home.js";
import type { OpenClawConfig } from "../config.js";
import { resolveAllAgentSessionStoreTargets } from "./targets.js";

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

      const targets = await resolveAllAgentSessionStoreTargets(cfg, { env: process.env });

      expect(targets).toEqual(
        expect.arrayContaining([
          {
            agentId: "ops",
            storePath: path.join(opsSessionsDir, "sessions.json"),
          },
          {
            agentId: "retired",
            storePath: path.join(retiredSessionsDir, "sessions.json"),
          },
        ]),
      );
      expect(
        targets.filter((target) => target.storePath === path.join(opsSessionsDir, "sessions.json")),
      ).toHaveLength(1);
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

      const targets = await resolveAllAgentSessionStoreTargets(cfg, { env: process.env });

      expect(targets).toEqual(
        expect.arrayContaining([
          {
            agentId: "ops",
            storePath: path.join(opsSessionsDir, "sessions.json"),
          },
          {
            agentId: "retired",
            storePath: path.join(retiredSessionsDir, "sessions.json"),
          },
        ]),
      );
      expect(
        targets.filter((target) => target.storePath === path.join(opsSessionsDir, "sessions.json")),
      ).toHaveLength(1);
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

      const targets = await resolveAllAgentSessionStoreTargets(cfg, { env: process.env });

      expect(targets).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            agentId: "retired-agent",
            storePath: path.join(retiredSessionsDir, "sessions.json"),
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

      const targets = await resolveAllAgentSessionStoreTargets(cfg, { env });

      expect(targets).toEqual(
        expect.arrayContaining([
          {
            agentId: "main",
            storePath: path.join(mainSessionsDir, "sessions.json"),
          },
          {
            agentId: "retired",
            storePath: path.join(retiredSessionsDir, "sessions.json"),
          },
        ]),
      );
    });
  });
});
