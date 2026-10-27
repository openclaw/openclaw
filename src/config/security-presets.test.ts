import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveExecDefaults } from "../agents/exec-defaults.js";
import { resolveExecToolConfig } from "../agents/lazy-exec-tool.js";
import { createConfigIO } from "./io.factory.js";
import { materializeRuntimeConfig } from "./materialize.js";
import { withTempHome, withTempHomeConfig } from "./test-helpers.js";
import type { OpenClawConfig } from "./types.openclaw.js";
import { validateConfigObject } from "./validation.js";

const materialize = (config: OpenClawConfig) =>
  materializeRuntimeConfig(config, { manifestRegistry: { plugins: [] } });

describe("security preset configuration", () => {
  it("defaults to trusted personal execution without changing authored config", () => {
    const source: OpenClawConfig = {};
    const config = materialize(source);
    expect(source).toEqual({});
    expect(config.security?.preset).toBe("personal");
    expect(config.agents?.defaults?.sandbox?.mode).toBe("off");
    expect(config.tools?.exec?.mode).toBe("full");
    expect(config.tools?.fs?.workspaceOnly).toBe(false);
    expect(config.tools?.exec?.applyPatch?.workspaceOnly).toBe(false);
    expect(config.messages?.queue).toMatchObject({
      allowCollaborativeSteering: true,
      collaborativeSteeringFallback: "queue",
    });
  });

  it("selects sandboxed sender-separated corporate defaults", () => {
    const config = materialize({ security: { preset: "corporate" } });
    expect(config.agents?.defaults?.sandbox).toMatchObject({
      mode: "all",
      scope: "session",
      workspaceAccess: "rw",
      docker: { network: "none" },
    });
    expect(config.tools).toMatchObject({
      exec: { mode: "ask", strictInlineEval: true, applyPatch: { workspaceOnly: true } },
      fs: { workspaceOnly: true },
      elevated: { enabled: false },
      sessions: { visibility: "tree" },
      agentToAgent: { enabled: false },
      message: { crossContext: { allowWithinProvider: false, allowAcrossProviders: false } },
    });
    expect(config.messages?.queue).toMatchObject({
      allowCollaborativeSteering: false,
      collaborativeSteeringFallback: "reject",
    });
    expect(config.session?.dmScope).toBe("per-account-channel-peer");
  });

  it.each(["personal", "corporate"] as const)("preserves explicit policy under %s", (preset) => {
    const config = materialize({
      security: { preset },
      tools: {
        deny: ["write"],
        exec: { security: "deny", ask: "always" },
        fs: { workspaceOnly: true },
      },
      agents: {
        defaults: { sandbox: { mode: "non-main" } },
        entries: { main: { tools: { exec: { mode: "allowlist" } } } },
      },
      messages: {
        queue: { allowCollaborativeSteering: false, collaborativeSteeringFallback: "queue" },
      },
      session: { dmScope: "per-peer" },
    });
    expect(config.tools?.exec?.mode).toBeUndefined();
    expect(config.tools?.exec).toMatchObject({ security: "deny", ask: "always" });
    expect(config.tools?.deny).toEqual(["write"]);
    expect(config.tools?.fs?.workspaceOnly).toBe(true);
    expect(config.agents?.defaults?.sandbox?.mode).toBe("non-main");
    expect(config.messages?.queue).toMatchObject({
      allowCollaborativeSteering: false,
      collaborativeSteeringFallback: "queue",
    });
    expect(config.session?.dmScope).toBe("per-peer");
    expect(resolveExecToolConfig({ cfg: config, agentId: "main" }).mode).toBe("allowlist");
  });

  it("does not turn a personal preset into a host approval or required-sandbox bypass", () => {
    const cfg = materialize({
      security: { preset: "personal" },
      agents: { entries: { main: {} } },
    });
    expect(
      resolveExecDefaults({
        cfg,
        agentId: "main",
        sandboxAvailable: false,
        execApprovals: { version: 1, defaults: { security: "deny", ask: "always" } },
      }),
    ).toMatchObject({ security: "deny", ask: "always" });
    expect(
      resolveExecDefaults({
        cfg,
        agentId: "main",
        sandboxAvailable: true,
        sessionEntry: { sandbox: "required" },
      }),
    ).toMatchObject({ effectiveHost: "sandbox", canRequestNode: false });
  });

  it("rejects unsupported preset values", () => {
    expect(validateConfigObject({ security: { preset: "unknown" } }).ok).toBe(false);
  });

  it("creates a config without pinning preset-derived overrides", async () => {
    await withTempHome(async (home) => {
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      const io = createConfigIO({
        env: { ...process.env, OPENCLAW_CONFIG_PATH: configPath },
        observe: false,
        pluginValidation: "core-only",
      });
      await io.writeConfigFile(
        { security: { preset: "corporate" } },
        { skipRuntimeSnapshotRefresh: true },
      );
      const persisted = JSON.parse(await fs.readFile(configPath, "utf8")) as OpenClawConfig;
      expect(persisted.messages?.queue).toBeUndefined();
      expect(persisted.tools).toBeUndefined();
      expect(persisted.agents?.defaults?.sandbox).toBeUndefined();
      expect(
        (await io.readConfigFileSnapshot()).runtimeConfig.messages?.queue
          ?.allowCollaborativeSteering,
      ).toBe(false);
    });
  });

  it("switches only the authored preset without persisting the previous runtime defaults", async () => {
    await withTempHomeConfig(
      { security: { preset: "corporate" }, tools: { exec: { mode: "deny" } } },
      async ({ configPath }) => {
        const io = createConfigIO({
          env: { ...process.env, OPENCLAW_CONFIG_PATH: configPath },
          observe: false,
          pluginValidation: "core-only",
        });
        const { snapshot, writeOptions } = await io.readConfigFileSnapshotForWrite();
        expect(snapshot.runtimeConfig.agents?.defaults?.sandbox?.mode).toBe("all");
        await io.writeConfigFile(
          { ...snapshot.runtimeConfig, security: { preset: "personal" } },
          {
            ...writeOptions,
            baseSnapshot: snapshot,
            inputBase: "runtime",
            skipRuntimeSnapshotRefresh: true,
          },
        );
        const persisted = JSON.parse(await fs.readFile(configPath, "utf8")) as OpenClawConfig;
        expect(persisted.security?.preset).toBe("personal");
        expect(persisted.tools?.exec?.mode).toBe("deny");
        expect(persisted.tools?.fs).toBeUndefined();
        expect(persisted.agents?.defaults?.sandbox).toBeUndefined();
        expect(persisted.messages?.queue).toBeUndefined();
        const reloaded = await io.readConfigFileSnapshot();
        expect(reloaded.runtimeConfig.agents?.defaults?.sandbox?.mode).toBe("off");
        expect(reloaded.runtimeConfig.messages?.queue?.allowCollaborativeSteering).toBe(true);
        expect(reloaded.runtimeConfig.tools?.exec?.mode).toBe("deny");
      },
    );
  });
});
