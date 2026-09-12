import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it } from "vitest";
import { EMPTY_LEGACY_SESSION_SURFACES } from "../plugins/legacy-session-surfaces.types.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { detectLegacyStateMigrations } from "./state-migrations.doctor.js";
import { migrateLegacyAgentDir } from "./state-migrations.legacy-sessions.js";

describe("legacy agent directory migration", () => {
  it.each(["custom-agent", "agent"])(
    "honors the configured agent directory %s",
    async (directory) => {
      await withOpenClawTestState({ label: "legacy-agent-configured" }, async (state) => {
        await state.writeText("agent/settings.json", "legacy settings");
        const targetDir = state.statePath(directory);
        const detected = await detectLegacyStateMigrations({
          cfg: { agents: { entries: { main: { agentDir: targetDir } } } },
          env: state.env,
          legacySessionSurfaces: EMPTY_LEGACY_SESSION_SURFACES,
        });
        expect(detected.agentDir.targetDir).toBe(targetDir);
        expect(detected.agentDir.hasLegacy).toBe(directory !== "agent");
        const result = await migrateLegacyAgentDir(detected, () => 1234);
        expect(result.warnings).toEqual([]);
        await expect(fs.readFile(path.join(targetDir, "settings.json"), "utf8")).resolves.toBe(
          "legacy settings",
        );
      });
    },
  );

  it("merges nested binaries, keeps destination bytes, and quarantines only conflicts once", async () => {
    await withOpenClawTestState({ label: "legacy-agent-merge" }, async (state) => {
      await state.writeText("agent/bin/rg", "legacy binary");
      await state.writeText("agent/bin/fd", "identical binary");
      await state.writeText("agent/bin/nested/tool", "missing tool");
      await state.writeText("agents/main/agent/bin/rg", "current binary");
      await state.writeText("agents/main/agent/bin/fd", "identical binary");
      const detect = () =>
        detectLegacyStateMigrations({
          cfg: { agents: { entries: { main: {} } } },
          env: state.env,
          legacySessionSurfaces: EMPTY_LEGACY_SESSION_SURFACES,
        });

      const result = await migrateLegacyAgentDir(await detect(), () => 1234);

      await expect(fs.readFile(state.agentDir() + "/bin/nested/tool", "utf8")).resolves.toBe(
        "missing tool",
      );
      await expect(fs.readFile(state.agentDir() + "/bin/rg", "utf8")).resolves.toBe(
        "current binary",
      );
      await expect(fs.readFile(state.agentDir() + "/bin/fd", "utf8")).resolves.toBe(
        "identical binary",
      );
      const agentRoot = path.dirname(state.agentDir());
      const quarantines = (await fs.readdir(agentRoot)).filter((name) =>
        name.startsWith("agent.legacy-"),
      );
      expect(quarantines).toHaveLength(1);
      const quarantine = path.join(agentRoot, expectDefined(quarantines[0], "conflict quarantine"));
      await expect(fs.readFile(path.join(quarantine, "bin/rg"), "utf8")).resolves.toBe(
        "legacy binary",
      );
      expect(await fs.readdir(path.join(quarantine, "bin"))).toEqual(["rg"]);
      expect(result).toMatchObject({ warningDisposition: "recoverable" });
      expect(result.warnings).toEqual([expect.stringContaining(path.join(quarantine, "bin/rg"))]);
      expect(result.changes).toContainEqual(expect.stringContaining(path.join("bin", "nested")));
      await expect(fs.stat(state.statePath("agent"))).rejects.toMatchObject({ code: "ENOENT" });

      // An older binary can recreate an identical file between Doctor runs.
      await state.writeText("agent/bin/fd", "identical binary");
      const repeated = await migrateLegacyAgentDir(await detect(), () => 5678);
      expect(repeated.warnings).toEqual([]);
      expect(
        (await fs.readdir(agentRoot)).filter((name) => name.startsWith("agent.legacy-")),
      ).toEqual(quarantines);
    });
  });

  it("reports old quarantine artifacts without requiring a new legacy payload or deleting data", async () => {
    await withOpenClawTestState({ label: "legacy-agent-quarantine" }, async (state) => {
      await state.writeText("agents/main/agent.legacy-1234/bin/rg", "preserved binary");
      const detected = await detectLegacyStateMigrations({
        cfg: { agents: { entries: { main: {} } } },
        env: state.env,
        legacySessionSurfaces: EMPTY_LEGACY_SESSION_SURFACES,
      });
      expect(detected.agentDir.hasLegacy).toBe(false);
      expect(detected.notices).toContainEqual(expect.stringContaining("older than 30 days"));
      await expect(
        fs.readFile(state.statePath("agents/main/agent.legacy-1234/bin/rg"), "utf8"),
      ).resolves.toBe("preserved binary");
    });
  });

  it("does not create another quarantine when an old runtime recreates identical binaries", async () => {
    await withOpenClawTestState({ label: "legacy-agent-repeat" }, async (state) => {
      await state.writeText("agent/bin/fd", "identical binary");
      await state.writeText("agents/main/agent/bin/fd", "identical binary");
      await state.writeText("agents/main/agent.legacy-1234/bin/rg", "preserved binary");
      const detected = await detectLegacyStateMigrations({
        cfg: { agents: { entries: { main: {} } } },
        env: state.env,
        legacySessionSurfaces: EMPTY_LEGACY_SESSION_SURFACES,
      });
      await migrateLegacyAgentDir(detected, () => 5678);
      expect(
        (await fs.readdir(path.dirname(state.agentDir()))).filter((name) =>
          name.startsWith("agent.legacy-"),
        ),
      ).toEqual(["agent.legacy-1234"]);
      await expect(fs.stat(state.statePath("agent"))).rejects.toMatchObject({ code: "ENOENT" });
    });
  });
});
