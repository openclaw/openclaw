import syncFs from "node:fs";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import * as roster from "../agents/agent-roster.js";
import * as agentDirs from "./agent-dirs.js";
import { createConfigIO } from "./io.factory.js";
import { withTempHome, writeOpenClawConfig } from "./test-helpers.js";
import type { OpenClawConfig } from "./types.js";
import { validateConfigObject, validateConfigObjectRaw } from "./validation.js";

describe("multi-agent agentDir validation", () => {
  it("finds a binding-only directory collision without scanning the parsed roster per agent", () => {
    const stateDir = path.join(tmpdir(), "openclaw-agentdir-validation");
    const entries = Object.fromEntries(
      Array.from({ length: 16 }, (_, index) => [`agent-${index}`, {}]),
    );
    entries["agent-0"] = { agentDir: path.join(stateDir, "agents", "main", "agent") };
    using check = vi.spyOn(agentDirs, "findDuplicateAgentDirs");
    using scans = vi.spyOn(roster, "readAgentRosterProperty");

    const result = validateConfigObjectRaw(
      {
        agents: { ownership: "explicit", entries },
        bindings: [{ agentId: "main", match: { channel: "forum" } }],
      },
      { env: { OPENCLAW_STATE_DIR: stateDir } },
    );

    expect(result).toMatchObject({
      ok: false,
      issues: [{ path: "agents.entries", message: expect.stringContaining('"agent-0", "main"') }],
    });
    expect(check).toHaveBeenCalledTimes(1);
    const parsed = check.mock.calls[0]?.[0];
    expect(scans.mock.calls.filter(([cfg]) => cfg === parsed).length).toBeLessThanOrEqual(2);
  });

  it("keeps caller mutations separate from the parsed roster during directory checks", () => {
    const home = path.join(tmpdir(), "openclaw-roster-home");
    const alphaDir = path.join(home, ".openclaw", "agents", "alpha", "agent");
    const beta = { agentDir: path.join(home, "beta") };
    const config: OpenClawConfig = {
      agents: { ownership: "explicit", entries: { alpha: {}, beta } },
    };
    const deps = {
      env: {},
      homedir: () => {
        beta.agentDir = alphaDir;
        return home;
      },
    };

    expect(validateConfigObjectRaw(config, deps).ok).toBe(true);
    expect(beta.agentDir).toBe(alphaDir);
    beta.agentDir = path.join(home, "beta");
    expect(agentDirs.findDuplicateAgentDirs(config, deps)).toEqual([
      { agentDir: alphaDir, agentIds: ["alpha", "beta"] },
    ]);
  });

  it("validates one referenced agent without resolving its filesystem identity", () => {
    const agentDir = path.join(tmpdir(), "openclaw-single-agentdir");
    using realpath = vi.spyOn(syncFs.realpathSync, "native");

    const result = validateConfigObject({
      agents: {
        entries: { alpha: { agentDir } },
      },
      bindings: [{ agentId: "alpha", match: { channel: "forum" } }],
    });

    expect(result.ok).toBe(true);
    expect(realpath.mock.calls.filter(([target]) => target === agentDir)).toEqual([]);
  });

  it.each(["OPENCLAW_HOME", "homedir", "relative OPENCLAW_HOME"] as const)(
    "keeps config validation and runtime paths in the selected %s",
    async (homeSource) => {
      await withTempHome(async (cliHome) => {
        const daemonHome = path.join(cliHome, "daemon");
        const daemonShared = path.join(daemonHome, "shared");
        const cliShared = path.join(cliHome, "shared");
        await fs.mkdir(daemonShared, { recursive: true });
        await fs.mkdir(cliShared);
        const env: NodeJS.ProcessEnv =
          homeSource === "homedir"
            ? {}
            : homeSource === "relative OPENCLAW_HOME"
              ? { OPENCLAW_HOME: "~/daemon" }
              : { [homeSource]: daemonHome };
        const config: OpenClawConfig = {
          agents: {
            ownership: "explicit",
            entries: { a: { agentDir: "~/shared" }, b: { agentDir: cliShared } },
          },
        };
        const configPath = await writeOpenClawConfig(daemonHome, config);
        const raw = await fs.readFile(configPath, "utf8");
        const io = createConfigIO({
          configPath,
          env,
          homedir: homeSource === "relative OPENCLAW_HOME" ? undefined : () => daemonHome,
          observe: false,
          pluginValidation: "core-only",
          logger: { error: vi.fn(), warn: vi.fn() },
        });

        const snapshot = await io.readConfigFileSnapshot();
        expect(snapshot.valid, JSON.stringify(snapshot.issues)).toBe(true);
        const expected = { a: { agentDir: daemonShared }, b: { agentDir: cliShared } };
        expect(snapshot.runtimeConfig.agents?.entries).toEqual(expected);
        expect(io.loadConfig().agents?.entries).toEqual(expected);
        expect(snapshot.sourceConfig.agents?.entries).toEqual(config.agents?.entries);
        await expect(fs.readFile(configPath, "utf8")).resolves.toBe(raw);

        await writeOpenClawConfig(daemonHome, {
          agents: {
            ownership: "explicit",
            entries: { a: { agentDir: "~/shared" }, b: { agentDir: daemonShared } },
          },
        });
        const collision = await io.readConfigFileSnapshot();
        expect(collision.valid).toBe(false);
        expect(collision.issues).toContainEqual({
          path: "agents.entries",
          message: expect.stringContaining("Duplicate agentDir"),
        });
        expect(() => io.loadConfig()).toThrow(/Duplicate agentDir/);
      });
    },
  );
});
