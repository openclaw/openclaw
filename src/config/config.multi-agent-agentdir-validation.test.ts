import syncFs from "node:fs";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createConfigIO } from "./io.factory.js";
import { withTempHome, writeOpenClawConfig } from "./test-helpers.js";
import type { OpenClawConfig } from "./types.js";
import { validateConfigObject } from "./validation.js";

describe("multi-agent agentDir validation", () => {
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
