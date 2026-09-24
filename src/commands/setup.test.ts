// Setup command tests cover local setup initialization and next-step messaging.
import fs from "node:fs/promises";
import path from "node:path";
import { withTempHome } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import { replaceConfigFile } from "../config/mutate.js";
import type { OpenClawConfig } from "../config/types.js";
import { setupCommand } from "./setup.js";
import { createTestRuntime } from "./test-runtime-config-helpers.js";

// Real config operations must stay inside this case even with an inherited config override.
function withSetupHome(run: (home: string) => Promise<void>): Promise<void> {
  return withTempHome(run, {
    env: {
      OPENCLAW_CONFIG_PATH: (home) => path.join(home, ".openclaw", "openclaw.json"),
    },
  });
}

// Observe canonical owners without replacing their filesystem or config effects.
async function observeSetupOwners() {
  const [config, workspace, sessions] = await Promise.all([
    import("../config/config.js"),
    import("../agents/workspace.js"),
    import("../config/sessions.js"),
  ]);
  return {
    replaceConfigFile: vi.spyOn(config, "replaceConfigFile"),
    ensureAgentWorkspace: vi.spyOn(workspace, "ensureAgentWorkspace"),
    resolveSessionTranscriptsDir: vi.spyOn(sessions, "resolveSessionTranscriptsDirForAgent"),
    mkdir: vi.spyOn(fs, "mkdir"),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("setupCommand", () => {
  it("writes gateway.mode=local on first run", async () => {
    await withSetupHome(async (home) => {
      const runtime = createTestRuntime();
      const effects = await observeSetupOwners();
      const workspace = path.join(home, ".openclaw", "workspace");

      await setupCommand({ workspace }, runtime);

      const configPath = path.join(home, ".openclaw", "openclaw.json");
      const raw = JSON.parse(await fs.readFile(configPath, "utf-8")) as unknown;

      expect(raw).toMatchObject({
        agents: {
          defaults: {
            workspace,
          },
          entries: { main: {} },
        },
        gateway: {
          mode: "local",
        },
      });
      expect(effects.replaceConfigFile).toHaveBeenCalledWith(
        expect.objectContaining({
          baseHash: expect.any(String),
          writeOptions: expect.objectContaining({
            expectedConfigPath: configPath,
            ownedConfigPathForWrite: configPath,
          }),
        }),
      );
      expect(effects.resolveSessionTranscriptsDir).toHaveBeenCalledWith("main");
    });
  });

  it("explains that plain setup only initializes local files", async () => {
    await withSetupHome(async (home) => {
      const runtime = createTestRuntime();

      await setupCommand({ workspace: path.join(home, "workspace") }, runtime);

      expect(runtime.log.mock.calls.map((call) => String(call[0])).slice(-5)).toStrictEqual([
        "",
        "Setup complete: config, workspace, and session directories are ready.",
        "Next guided path: openclaw onboard.",
        "Next targeted changes: openclaw configure for models, channels, Gateway, plugins, skills, and health checks.",
        "Add a chat channel later: openclaw channels add.",
      ]);
    });
  });

  it("emits one structured result for baseline JSON output", async () => {
    await withSetupHome(async (home) => {
      const runtime = createTestRuntime();
      const workspace = path.join(home, ".openclaw", "workspace");

      await setupCommand({ workspace, json: true }, runtime);

      expect(runtime.log).toHaveBeenCalledOnce();
      expect(JSON.parse(String(runtime.log.mock.calls[0]?.[0]))).toEqual({
        ok: true,
        configPath: path.join(home, ".openclaw", "openclaw.json"),
        configStatus: "created",
        workspaceDir: workspace,
        sessionsDir: path.join(home, ".openclaw", "agents", "main", "sessions"),
      });
    });
  });

  it("updates the default entry workspace created by fresh setup", async () => {
    await withSetupHome(async (home) => {
      const runtime = createTestRuntime();
      const initialWorkspace = path.join(home, "initial-workspace");
      const nextWorkspace = path.join(home, "next-workspace");

      await setupCommand({ workspace: initialWorkspace }, runtime);
      await setupCommand({ workspace: nextWorkspace }, runtime);

      const config = JSON.parse(
        await fs.readFile(path.join(home, ".openclaw", "openclaw.json"), "utf8"),
      ) as OpenClawConfig;
      expect(resolveAgentWorkspaceDir(config, "main")).toBe(nextWorkspace);
      expect(config.agents?.defaults?.workspace).toBe(nextWorkspace);
      expect(config.agents?.entries?.main?.workspace).toBe(nextWorkspace);
    });
  });

  it("keeps the default entry workspace on bare setup", async () => {
    await withSetupHome(async (home) => {
      const runtime = createTestRuntime();
      const configDir = path.join(home, ".openclaw");
      const configPath = path.join(configDir, "openclaw.json");
      const workspace = path.join(home, "ops-workspace");
      const raw = JSON.stringify({
        agents: { entries: { ops: { default: true, workspace } } },
        gateway: { mode: "local" },
      });
      await fs.mkdir(configDir, { recursive: true });
      await fs.writeFile(configPath, raw);
      const effects = await observeSetupOwners();

      await setupCommand(undefined, runtime);

      expect(await fs.readFile(configPath, "utf8")).toBe(raw);
      expect(effects.ensureAgentWorkspace.mock.calls[0]?.[0]?.dir).toBe(workspace);
      expect(effects.resolveSessionTranscriptsDir).toHaveBeenCalledWith("ops");
      expect(
        (await fs.stat(path.join(home, ".openclaw", "agents", "ops", "sessions"))).isDirectory(),
      ).toBe(true);

      const nextWorkspace = path.join(home, "next-ops-workspace");
      await setupCommand({ workspace: nextWorkspace }, runtime);
      const updated = JSON.parse(await fs.readFile(configPath, "utf8")) as OpenClawConfig;
      expect(resolveAgentWorkspaceDir(updated, "ops")).toBe(nextWorkspace);
      expect(updated.agents?.entries?.ops?.workspace).toBe(nextWorkspace);
    });
  });

  it("does not copy an entry workspace into defaults during a gateway-only write", async () => {
    await withSetupHome(async (home) => {
      const runtime = createTestRuntime();
      const configDir = path.join(home, ".openclaw");
      const configPath = path.join(configDir, "openclaw.json");
      const workspace = path.join(home, "ops-workspace");
      await fs.mkdir(configDir, { recursive: true });
      await fs.writeFile(
        configPath,
        JSON.stringify({
          agents: { entries: { ops: { default: true, workspace } } },
        }),
      );

      await setupCommand(undefined, runtime);

      const config = JSON.parse(await fs.readFile(configPath, "utf8")) as OpenClawConfig;
      expect(config.agents?.defaults?.workspace).toBeUndefined();
      expect(config.agents?.entries?.ops?.workspace).toBe(workspace);
      expect(config.gateway?.mode).toBe("local");
    });
  });

  it("adds gateway.mode=local to an existing config without overwriting workspace", async () => {
    await withSetupHome(async (home) => {
      const runtime = createTestRuntime();
      const configDir = path.join(home, ".openclaw");
      const configPath = path.join(configDir, "openclaw.json");
      const workspace = path.join(home, "custom-workspace");

      await fs.mkdir(configDir, { recursive: true });
      await fs.writeFile(
        configPath,
        JSON.stringify({
          agents: {
            defaults: {
              workspace,
            },
          },
        }),
      );

      await setupCommand(undefined, runtime);

      const raw = JSON.parse(await fs.readFile(configPath, "utf-8")) as {
        agents?: { defaults?: { workspace?: string } };
        gateway?: { mode?: string };
      };

      expect(raw.agents?.defaults?.workspace).toBe(workspace);
      expect(raw.gateway?.mode).toBe("local");
    });
  });

  it("leaves an include-owned roster in its authored file", async () => {
    await withSetupHome(async (home) => {
      const runtime = createTestRuntime();
      const configDir = path.join(home, ".openclaw");
      const configPath = path.join(configDir, "openclaw.json");
      const includePath = path.join(configDir, "agents.json");
      const workspace = path.join(home, "ops-workspace");
      const rootRaw = `{
        $include: "./agents.json"
      }`;
      await fs.mkdir(configDir, { recursive: true });
      await fs.writeFile(configPath, rootRaw);
      await fs.writeFile(
        includePath,
        JSON.stringify({
          agents: {
            defaults: { workspace },
            entries: { ops: { default: true } },
          },
          gateway: { mode: "local" },
        }),
      );
      const effects = await observeSetupOwners();

      await setupCommand(undefined, runtime);

      expect(await fs.readFile(configPath, "utf8")).toBe(rootRaw);
      expect(effects.resolveSessionTranscriptsDir).toHaveBeenCalledWith("ops");
    });
  });

  it("updates only inherited workspace defaults beside an include-owned roster", async () => {
    await withSetupHome(async (home) => {
      const runtime = createTestRuntime();
      const configDir = path.join(home, ".openclaw");
      const configPath = path.join(configDir, "openclaw.json");
      const includePath = path.join(configDir, "agents.json");
      const oldWorkspace = path.join(home, "old-workspace");
      const nextWorkspace = path.join(home, "next-workspace");
      const included = {
        agents: {
          defaults: { workspace: oldWorkspace },
          entries: { ops: { default: true, workspace: "   " } },
        },
        gateway: { mode: "local" },
      };
      await fs.mkdir(configDir, { recursive: true });
      await fs.writeFile(configPath, JSON.stringify({ $include: "./agents.json" }));
      await fs.writeFile(includePath, JSON.stringify(included));

      await setupCommand({ workspace: nextWorkspace }, runtime);

      const root = JSON.parse(await fs.readFile(configPath, "utf8")) as OpenClawConfig & {
        $include?: string;
      };
      expect(root.$include).toBe("./agents.json");
      expect(root.agents?.defaults?.workspace).toBe(nextWorkspace);
      expect(root.agents?.entries).toBeUndefined();
      expect(JSON.parse(await fs.readFile(includePath, "utf8"))).toEqual(included);
    });
  });

  it("updates inherited workspace defaults below a nested roster include", async () => {
    await withSetupHome(async (home) => {
      const runtime = createTestRuntime();
      const configDir = path.join(home, ".openclaw");
      const configPath = path.join(configDir, "openclaw.json");
      const includePath = path.join(configDir, "agents.json");
      const oldWorkspace = path.join(home, "old-workspace");
      const nextWorkspace = path.join(home, "next-workspace");
      const includedAgents = {
        defaults: { workspace: oldWorkspace },
        entries: { ops: { default: true } },
      };
      await fs.mkdir(configDir, { recursive: true });
      await fs.writeFile(
        configPath,
        JSON.stringify({ agents: { $include: "./agents.json" }, gateway: { mode: "local" } }),
      );
      await fs.writeFile(includePath, JSON.stringify(includedAgents));

      await setupCommand({ workspace: nextWorkspace }, runtime);

      const root = JSON.parse(await fs.readFile(configPath, "utf8")) as {
        agents?: {
          $include?: string;
          defaults?: { workspace?: string };
          entries?: unknown;
        };
      };
      expect(root.agents).toMatchObject({
        $include: "./agents.json",
        defaults: { workspace: nextWorkspace },
      });
      expect(root.agents?.entries).toBeUndefined();
      expect(JSON.parse(await fs.readFile(includePath, "utf8"))).toEqual(includedAgents);
    });
  });

  it("persists a roster when existing setup settings already match", async () => {
    await withSetupHome(async (home) => {
      const runtime = createTestRuntime();
      const configDir = path.join(home, ".openclaw");
      const configPath = path.join(configDir, "openclaw.json");
      const workspace = path.join(home, "workspace");
      await fs.mkdir(configDir, { recursive: true });
      await fs.writeFile(
        configPath,
        JSON.stringify({
          agents: { defaults: { workspace } },
          gateway: { mode: "local" },
        }),
      );

      await setupCommand(undefined, runtime);

      const config = JSON.parse(await fs.readFile(configPath, "utf8")) as OpenClawConfig;
      expect(config.agents?.entries).toEqual({ main: {} });
    });
  });

  it("threads skipOptionalBootstrapFiles into workspace creation", async () => {
    await withSetupHome(async (home) => {
      const runtime = createTestRuntime();
      const configDir = path.join(home, ".openclaw");
      const configPath = path.join(configDir, "openclaw.json");
      const effects = await observeSetupOwners();
      const workspace = path.join(home, "custom-workspace");

      await fs.mkdir(configDir, { recursive: true });
      await fs.writeFile(
        configPath,
        JSON.stringify({
          agents: {
            defaults: {
              workspace,
              skipOptionalBootstrapFiles: ["IDENTITY.md", "USER.md"],
            },
          },
        }),
      );

      await setupCommand(undefined, runtime);

      expect((await fs.stat(path.join(workspace, "AGENTS.md"))).isFile()).toBe(true);
      await expect(fs.stat(path.join(workspace, "IDENTITY.md"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(fs.stat(path.join(workspace, "USER.md"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(effects.ensureAgentWorkspace).toHaveBeenCalledOnce();
      const workspaceParams = effects.ensureAgentWorkspace.mock.calls[0]?.[0];
      expect(workspaceParams?.dir).toBe(workspace);
      expect(workspaceParams?.skipOptionalBootstrapFiles).toEqual(["IDENTITY.md", "USER.md"]);
    });
  });

  it.each([false, true])(
    "rejects a foreign write before the final config commit (fresh: %s)",
    async (fresh) => {
      await withSetupHome(async (home) => {
        const runtime = createTestRuntime();
        const configDir = path.join(home, ".openclaw");
        const configPath = path.join(configDir, "openclaw.json");
        const workspace = path.join(home, "custom-workspace");
        const effects = await observeSetupOwners();
        const externalRaw = `${JSON.stringify({ external: true }, null, 2)}\n`;

        await fs.mkdir(configDir, { recursive: true });
        if (!fresh) {
          await fs.writeFile(
            configPath,
            JSON.stringify({ agents: { defaults: { workspace } } }),
            "utf-8",
          );
        }
        const sessionsDir = path.join(home, ".openclaw", "agents", "main", "sessions");
        const sessionMkdirCalls = () =>
          effects.mkdir.mock.calls.filter(([dir]) => dir === sessionsDir).length;
        const beforeFinalWrite = { workspace: 0, sessions: 0, mkdir: 0 };
        let finalWriteReached = false;
        let finalWriteBasis: string | null | undefined;
        effects.replaceConfigFile.mockImplementationOnce(async (params) => {
          // The facade export is setup's final replace, not first-agent creation's transform.
          finalWriteBasis = fresh ? params.baseHash : params.snapshot?.hash;
          finalWriteReached = true;
          await fs.writeFile(configPath, externalRaw, "utf-8");
          beforeFinalWrite.workspace = effects.ensureAgentWorkspace.mock.calls.length;
          beforeFinalWrite.sessions = effects.resolveSessionTranscriptsDir.mock.calls.length;
          beforeFinalWrite.mkdir = sessionMkdirCalls();
          return await replaceConfigFile(params);
        });

        await expect(setupCommand({ workspace }, runtime)).rejects.toThrow(
          "config changed since last load",
        );

        expect(await fs.readFile(configPath, "utf-8")).toBe(externalRaw);
        expect(finalWriteReached).toBe(true);
        expect(finalWriteBasis).toEqual(expect.any(String));
        // Fresh creation may already provision files; failure must stop subsequent setup effects.
        expect(effects.ensureAgentWorkspace).toHaveBeenCalledTimes(beforeFinalWrite.workspace);
        expect(effects.resolveSessionTranscriptsDir).toHaveBeenCalledTimes(
          beforeFinalWrite.sessions,
        );
        expect(sessionMkdirCalls()).toBe(beforeFinalWrite.mkdir);
      });
    },
  );

  it.each([false, true])(
    "preserves malformed config and reports failure (json: %s)",
    async (json) => {
      await withSetupHome(async (home) => {
        const runtime = createTestRuntime();
        const configDir = path.join(home, ".openclaw");
        const configPath = path.join(configDir, "openclaw.json");
        const effects = await observeSetupOwners();
        const original = Buffer.from('{ "gateway": ', "utf-8");

        await fs.mkdir(configDir, { recursive: true });
        await fs.writeFile(configPath, original);

        await setupCommand(json ? { json: true } : undefined, runtime);

        expect(runtime.exit).toHaveBeenCalledWith(1);
        expect(runtime.error).toHaveBeenCalledWith(
          expect.stringContaining("openclaw doctor --fix"),
        );
        if (json) {
          expect(runtime.log).toHaveBeenCalledOnce();
          expect(JSON.parse(String(runtime.log.mock.calls[0]?.[0]))).toEqual({
            ok: false,
            error: {
              type: "cli_error",
              message: "OpenClaw config is invalid: ~/.openclaw/openclaw.json",
            },
            issues: expect.arrayContaining([
              expect.objectContaining({ path: "<root>", message: expect.any(String) }),
            ]),
          });
        } else {
          expect(runtime.log).not.toHaveBeenCalled();
        }
        expect(await fs.readFile(configPath)).toStrictEqual(original);
        expect(effects.replaceConfigFile).not.toHaveBeenCalled();
        expect(effects.ensureAgentWorkspace).not.toHaveBeenCalled();
        expect(effects.resolveSessionTranscriptsDir).not.toHaveBeenCalled();
        expect(
          effects.mkdir.mock.calls.filter(
            ([dir]) => dir === path.join(home, ".openclaw", "agents", "main", "sessions"),
          ),
        ).toEqual([]);
      });
    },
  );

  it.each([
    ["string", '"not-an-object"'],
    ["array", "[]"],
    ["null", "null"],
  ])(
    "preserves an existing %s config root and stops before setup mutations",
    async (_label, raw) => {
      await withSetupHome(async (home) => {
        const runtime = createTestRuntime();
        const configDir = path.join(home, ".openclaw");
        const configPath = path.join(configDir, "openclaw.json");
        const effects = await observeSetupOwners();

        await fs.mkdir(configDir, { recursive: true });
        await fs.writeFile(configPath, raw, "utf-8");

        await setupCommand(undefined, runtime);

        expect(runtime.exit).toHaveBeenCalledWith(1);
        expect(runtime.error).toHaveBeenCalledWith(
          expect.stringContaining("openclaw doctor --fix"),
        );
        expect(await fs.readFile(configPath, "utf-8")).toBe(raw);
        expect(effects.replaceConfigFile).not.toHaveBeenCalled();
        expect(effects.ensureAgentWorkspace).not.toHaveBeenCalled();
        expect(effects.resolveSessionTranscriptsDir).not.toHaveBeenCalled();
        expect(
          effects.mkdir.mock.calls.filter(
            ([dir]) => dir === path.join(home, ".openclaw", "agents", "main", "sessions"),
          ),
        ).toEqual([]);
      });
    },
  );

  it("uses systemAgent.agentId in multi-agent explicit mode", async () => {
    await withSetupHome(async (home) => {
      const runtime = createTestRuntime();
      const configDir = path.join(home, ".openclaw");
      const configPath = path.join(configDir, "openclaw.json");
      const effects = await observeSetupOwners();
      const agentAWorkspace = path.join(home, "agent-a-workspace");
      const agentBWorkspace = path.join(home, "agent-b-workspace");
      const preexisting: OpenClawConfig = {
        agents: {
          ownership: "explicit",
          entries: {
            "agent-a": { workspace: agentAWorkspace },
            "agent-b": { workspace: agentBWorkspace },
          },
          defaults: { systemAgent: { agentId: "agent-a" } },
        },
        gateway: { mode: "local" },
      };

      await fs.mkdir(configDir, { recursive: true });
      await fs.writeFile(configPath, JSON.stringify(preexisting), "utf-8");

      await setupCommand(undefined, runtime);

      expect(runtime.exit).not.toHaveBeenCalledWith(1);
      expect(effects.ensureAgentWorkspace.mock.calls[0]?.[0]?.dir).toBe(agentAWorkspace);
      expect(effects.resolveSessionTranscriptsDir).toHaveBeenCalledWith("agent-a");
    });
  });

  it("gives an actionable error when baseline setup has no ambient owner", async () => {
    await withSetupHome(async (home) => {
      const runtime = createTestRuntime();
      const configDir = path.join(home, ".openclaw");
      const configPath = path.join(configDir, "openclaw.json");
      const effects = await observeSetupOwners();
      const preexisting: OpenClawConfig = {
        agents: {
          ownership: "explicit",
          entries: { "agent-a": {}, "agent-b": {} },
        },
        gateway: { mode: "local" },
      };

      await fs.mkdir(configDir, { recursive: true });
      await fs.writeFile(configPath, JSON.stringify(preexisting), "utf-8");

      await expect(setupCommand(undefined, runtime)).rejects.toThrow(
        "Multiple agents are configured, but baseline setup has no explicit owner. Set agents.defaults.systemAgent.agentId.",
      );
      expect(effects.ensureAgentWorkspace).not.toHaveBeenCalled();
      expect(effects.resolveSessionTranscriptsDir).not.toHaveBeenCalled();
    });
  });
});
