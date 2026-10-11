// Setup command tests cover local setup initialization and next-step messaging.
import fs from "node:fs/promises";
import path from "node:path";
import { withTempHome } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import { replaceConfigFile } from "../config/mutate.js";
import type { OpenClawConfig } from "../config/types.js";
import { loadCronJobsStore, resolveCronJobsStorePath } from "../cron/store.js";
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
      expect((await fs.stat(path.join(workspace, "AGENTS.md"))).isFile()).toBe(true);
      expect((await loadCronJobsStore(resolveCronJobsStorePath())).jobs).toEqual([
        expect.objectContaining({
          agentId: "main",
          payload: expect.objectContaining({ kind: "agentTurn", skipIfScratchEmpty: true }),
        }),
      ]);
    });
  });

  it.each([false, true])(
    "preserves an included skip-bootstrap leaf (value: %s)",
    async (skipBootstrap) => {
      await withSetupHome(async (home) => {
        const configDir = path.join(home, ".openclaw");
        const configPath = path.join(configDir, "openclaw.json");
        const includePath = path.join(configDir, "skip-bootstrap.json");
        const workspace = path.join(home, "workspace");
        const rootRaw = JSON.stringify({
          agents: {
            defaults: { workspace, skipBootstrap: { $include: "./skip-bootstrap.json" } },
            entries: { ops: {} },
          },
          gateway: { mode: "local" },
        });
        await fs.mkdir(configDir, { recursive: true });
        await fs.writeFile(configPath, rootRaw);
        await fs.writeFile(includePath, JSON.stringify(skipBootstrap));

        const setup = setupCommand({ skipBootstrap: true }, createTestRuntime());
        if (skipBootstrap) {
          await setup;
          expect(await fs.readdir(workspace)).toEqual([]);
        } else {
          await expect(setup).rejects.toThrow("Edit the included file directly");
          await expect(fs.stat(workspace)).rejects.toMatchObject({ code: "ENOENT" });
        }
        expect(await fs.readFile(configPath, "utf8")).toBe(rootRaw);
        expect(await fs.readFile(includePath, "utf8")).toBe(JSON.stringify(skipBootstrap));
      });
    },
  );

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

  it.each([
    { scope: "root", skip: false, changeWorkspace: false, missingGateway: true },
    { scope: "defaults", skip: false, changeWorkspace: true, missingGateway: false },
  ])(
    "keeps $scope includes while skipping bootstrap (workspace: $changeWorkspace, gateway missing: $missingGateway)",
    async ({ scope, skip, changeWorkspace, missingGateway }) => {
      await withSetupHome(async (home) => {
        const runtime = createTestRuntime();
        const configDir = path.join(home, ".openclaw");
        const configPath = path.join(configDir, "openclaw.json");
        const includePath = path.join(configDir, "agents.json");
        const oldWorkspace = path.join(home, "old-workspace");
        const nextWorkspace = path.join(home, "next-workspace");
        const defaults = {
          workspace: oldWorkspace,
          skipBootstrap: skip,
          timeoutSeconds: 30,
        };
        const agents = { defaults, entries: { ops: {} } };
        const gateway = missingGateway ? {} : { mode: "local" };
        const include = { $include: "./agents.json" };
        const included =
          scope === "root" ? { agents, gateway } : scope === "defaults" ? defaults : agents;
        const authored =
          scope === "root"
            ? include
            : {
                agents:
                  scope === "defaults"
                    ? { defaults: include, entries: agents.entries }
                    : {
                        ...include,
                        ...(scope === "authored"
                          ? {
                              defaults: {
                                skipBootstrap: false,
                                ...(changeWorkspace ? { workspace: oldWorkspace } : {}),
                              },
                            }
                          : {}),
                      },
                gateway,
              };
        const includedRaw = JSON.stringify(included);
        await fs.mkdir(configDir, { recursive: true });
        await fs.writeFile(configPath, JSON.stringify(authored));
        await fs.writeFile(includePath, includedRaw);

        const options = {
          skipBootstrap: true,
          ...(changeWorkspace ? { workspace: nextWorkspace } : {}),
        };
        await setupCommand(options, runtime);

        const raw = await fs.readFile(configPath, "utf8");
        const root = JSON.parse(raw);
        const directive =
          scope === "root" ? root : scope === "defaults" ? root.agents.defaults : root.agents;
        expect(directive.$include).toBe("./agents.json");
        expect(root.agents?.defaults?.skipBootstrap).toBe(true);
        expect(root.agents.defaults.workspace).toBe(changeWorkspace ? nextWorkspace : undefined);
        expect(root.agents.entries).toEqual(scope === "defaults" ? agents.entries : undefined);
        expect(root.agents.defaults.timeoutSeconds).toBeUndefined();
        expect(root.gateway?.mode).toBe(
          missingGateway ? "local" : scope === "root" ? undefined : "local",
        );
        expect(await fs.readFile(includePath, "utf8")).toBe(includedRaw);
        const workspace = changeWorkspace ? nextWorkspace : oldWorkspace;
        expect((await fs.readdir(workspace)).filter((name) => name.endsWith(".md"))).toEqual([]);

        await setupCommand(undefined, runtime);

        expect(await fs.readFile(configPath, "utf8")).toBe(raw);
        expect(await fs.readFile(includePath, "utf8")).toBe(includedRaw);
        expect((await fs.readdir(workspace)).filter((name) => name.endsWith(".md"))).toEqual([]);
      });
    },
  );

  it.each(["legacy-entry", "local-entry"])(
    "handles combined workspace and bootstrap ownership (%s)",
    async (scope) => {
      await withSetupHome(async (home) => {
        const configDir = path.join(home, ".openclaw");
        const configPath = path.join(configDir, "openclaw.json");
        const includePath = path.join(configDir, "workspace.json");
        const oldWorkspace = path.join(home, "old-workspace");
        const workspace = path.join(home, "new-workspace");
        const include = { $include: "./workspace.json" };
        const defaults = {
          skipBootstrap: false,
          ...(scope === "local-entry" ? { systemAgent: { agentId: "ops" } } : {}),
        };
        const selected = { workspace: oldWorkspace };
        const included =
          scope === "defaults"
            ? oldWorkspace
            : scope === "local-entry"
              ? { workspace: oldWorkspace }
              : {
                  defaults,
                  ...(scope === "legacy-entry"
                    ? { list: [{ id: "ops", default: true, ...selected }] }
                    : { entries: { ops: selected } }),
                };
        const rootRaw = JSON.stringify({
          agents:
            scope === "defaults"
              ? {
                  defaults: { ...defaults, workspace: include },
                  entries: { ops: {} },
                }
              : scope === "local-entry"
                ? { ownership: "explicit", defaults, entries: { ops: selected, worker: include } }
                : include,
          gateway: { mode: "local" },
        });
        const includeRaw = JSON.stringify(included);
        await fs.mkdir(configDir, { recursive: true });
        await fs.writeFile(configPath, rootRaw);
        await fs.writeFile(includePath, includeRaw);

        const runtime = createTestRuntime();
        const setup = setupCommand({ workspace, skipBootstrap: true }, runtime);
        if (scope === "local-entry") {
          await setup;
          const config = JSON.parse(await fs.readFile(configPath, "utf8"));
          expect(config.agents.entries.ops.workspace).toBe(workspace);
          expect(config.agents.defaults.skipBootstrap).toBe(true);
          expect((await fs.readdir(workspace)).filter((name) => name.endsWith(".md"))).toEqual([]);
        } else {
          if (scope === "legacy-entry") {
            await setup;
            expect(runtime.exit).toHaveBeenCalledWith(1);
            expect(runtime.error).toHaveBeenCalledWith(
              expect.stringContaining("openclaw doctor --fix"),
            );
          } else {
            await expect(setup).rejects.toMatchObject({ code: "CONFIG_INCLUDE_OWNERSHIP" });
          }
          expect(await fs.readFile(configPath, "utf8")).toBe(rootRaw);
          await expect(fs.stat(workspace)).rejects.toMatchObject({ code: "ENOENT" });
        }
        expect(await fs.readFile(includePath, "utf8")).toBe(includeRaw);
      });
    },
  );

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

  it.each([true])("preserves malformed config and reports failure (json: %s)", async (json) => {
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
      expect(runtime.error).toHaveBeenCalledWith(expect.stringContaining("openclaw doctor --fix"));
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
  });

  it.each([["array", "[]"]])(
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
