import fs from "node:fs/promises";
import path from "node:path";
import { withTempHome } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import { replaceConfigFile } from "../config/mutate.js";
import type { OpenClawConfig } from "../config/types.js";
import { setupCommand } from "./setup.js";
import { createTestRuntime } from "./test-runtime-config-helpers.js";

function setupFixture(home: string) {
  const configDir = path.join(home, ".openclaw");
  const configPath = path.join(configDir, "openclaw.json");
  const write = async (file: string, value: unknown) => {
    const raw = JSON.stringify(value);
    await fs.mkdir(configDir, { recursive: true });
    await fs.writeFile(file, raw);
    return raw;
  };
  return {
    runtime: createTestRuntime(),
    configDir,
    configPath,
    writeConfig: (config: unknown) => write(configPath, config),
    readConfig: () => fs.readFile(configPath, "utf8"),
    writeInclude: async (name: string, value: unknown) => {
      const file = path.join(configDir, name);
      await write(file, value);
      return () => fs.readFile(file, "utf8");
    },
  };
}

function withSetupHome(
  run: (home: string, fixture: ReturnType<typeof setupFixture>) => Promise<void>,
) {
  return withTempHome((home) => run(home, setupFixture(home)), {
    env: { OPENCLAW_CONFIG_PATH: (home) => path.join(home, ".openclaw", "openclaw.json") },
  });
}

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

function expectNoSetupEffects(
  effects: Awaited<ReturnType<typeof observeSetupOwners>>,
  home: string,
) {
  expect(effects.replaceConfigFile).not.toHaveBeenCalled();
  expect(effects.ensureAgentWorkspace).not.toHaveBeenCalled();
  expect(effects.resolveSessionTranscriptsDir).not.toHaveBeenCalled();
  expect(
    effects.mkdir.mock.calls.filter(
      ([dir]) => dir === path.join(home, ".openclaw", "agents", "main", "sessions"),
    ),
  ).toEqual([]);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("setupCommand", () => {
  it.each([false, true])("initializes local setup (json: %s)", async (json) => {
    await withSetupHome(async (home, { runtime, configPath }) => {
      const workspace = path.join(home, ".openclaw", "workspace");

      await setupCommand({ workspace, json }, runtime);
      const raw = JSON.parse(await fs.readFile(configPath, "utf-8")) as unknown;

      expect(raw).toMatchObject({
        agents: { defaults: { workspace }, entries: { main: {} } },
        gateway: { mode: "local" },
        messages: { queue: { allowCollaborativeSteering: false } },
      });
      if (json) {
        expect(runtime.log).toHaveBeenCalledOnce();
        expect(JSON.parse(String(runtime.log.mock.calls[0]?.[0]))).toEqual({
          ok: true,
          configPath,
          configStatus: "created",
          workspaceDir: workspace,
          sessionsDir: path.join(home, ".openclaw", "agents", "main", "sessions"),
        });
      }
      expect((await fs.stat(path.join(workspace, "AGENTS.md"))).isFile()).toBe(true);
    });
  });

  it.each([false, true])(
    "preserves an included skip-bootstrap leaf (value: %s)",
    async (skipBootstrap) => {
      await withSetupHome(async (home, { runtime, writeConfig, readConfig, writeInclude }) => {
        const workspace = path.join(home, "workspace");
        const rootRaw = await writeConfig({
          agents: {
            defaults: { workspace, skipBootstrap: { $include: "./skip-bootstrap.json" } },
            entries: { ops: {} },
          },
          gateway: { mode: "local" },
        });
        const readInclude = await writeInclude("skip-bootstrap.json", skipBootstrap);

        const setup = setupCommand({ skipBootstrap: true }, runtime);
        if (skipBootstrap) {
          await setup;
          expect(await fs.readdir(workspace)).toEqual([]);
        } else {
          await expect(setup).rejects.toThrow("Edit the included file directly");
          await expect(fs.stat(workspace)).rejects.toMatchObject({ code: "ENOENT" });
        }
        expect(await readConfig()).toBe(rootRaw);
        expect(await readInclude()).toBe(JSON.stringify(skipBootstrap));
      });
    },
  );

  it.each([
    { scope: "root", skip: false, changeWorkspace: false, missingGateway: true },
    { scope: "defaults", skip: false, changeWorkspace: true, missingGateway: false },
  ])(
    "keeps $scope includes while skipping bootstrap (workspace: $changeWorkspace, gateway missing: $missingGateway)",
    async ({ scope, skip, changeWorkspace, missingGateway }) => {
      await withSetupHome(async (home, { runtime, writeConfig, readConfig, writeInclude }) => {
        const oldWorkspace = path.join(home, "old-workspace");
        const nextWorkspace = path.join(home, "next-workspace");
        const defaults = { workspace: oldWorkspace, skipBootstrap: skip, thinkingDefault: "low" };
        const agents = { defaults, entries: { ops: {} } };
        const gateway = missingGateway ? {} : { mode: "local" };
        const include = { $include: "./agents.json" };
        const included = scope === "root" ? { agents, gateway } : defaults;
        const authored =
          scope === "root"
            ? include
            : {
                agents: { defaults: include, entries: agents.entries },
                gateway,
              };
        const includedRaw = JSON.stringify(included);
        await writeConfig(authored);
        const readInclude = await writeInclude("agents.json", included);

        const options = {
          skipBootstrap: true,
          ...(changeWorkspace ? { workspace: nextWorkspace } : {}),
        };
        await setupCommand(options, runtime);

        const raw = await readConfig();
        const root = JSON.parse(raw);
        const directive = scope === "root" ? root : root.agents.defaults;
        expect(directive.$include).toBe("./agents.json");
        expect(root.agents?.defaults?.skipBootstrap).toBe(true);
        expect(root.agents.defaults.workspace).toBe(changeWorkspace ? nextWorkspace : undefined);
        expect(root.agents.entries).toEqual(scope === "defaults" ? agents.entries : undefined);
        expect(root.agents.defaults.thinkingDefault).toBeUndefined();
        expect(root.gateway?.mode).toBe(
          missingGateway ? "local" : scope === "root" ? undefined : "local",
        );
        expect(await readInclude()).toBe(includedRaw);
        const workspace = changeWorkspace ? nextWorkspace : oldWorkspace;
        expect((await fs.readdir(workspace)).filter((name) => name.endsWith(".md"))).toEqual([]);

        await setupCommand(undefined, runtime);

        expect(await readConfig()).toBe(raw);
        expect(await readInclude()).toBe(includedRaw);
        expect((await fs.readdir(workspace)).filter((name) => name.endsWith(".md"))).toEqual([]);
      });
    },
  );

  it.each(["legacy-entry", "local-entry"])(
    "handles combined workspace and bootstrap ownership (%s)",
    async (scope) => {
      await withSetupHome(async (home, { runtime, writeConfig, readConfig, writeInclude }) => {
        const oldWorkspace = path.join(home, "old-workspace");
        const workspace = path.join(home, "new-workspace");
        const include = { $include: "./workspace.json" };
        const defaults = {
          skipBootstrap: false,
          ...(scope === "local-entry" ? { systemAgent: { agentId: "ops" } } : {}),
        };
        const selected = { workspace: oldWorkspace };
        const included =
          scope === "local-entry"
            ? { workspace: oldWorkspace }
            : { defaults, list: [{ id: "ops", default: true, ...selected }] };
        const rootRaw = await writeConfig({
          agents:
            scope === "local-entry"
              ? { ownership: "explicit", defaults, entries: { ops: selected, worker: include } }
              : include,
          gateway: { mode: "local" },
        });
        const includeRaw = JSON.stringify(included);
        const readInclude = await writeInclude("workspace.json", included);

        const setup = setupCommand({ workspace, skipBootstrap: true }, runtime);
        await setup;
        if (scope === "local-entry") {
          const config = JSON.parse(await readConfig());
          expect(config.agents.entries.ops.workspace).toBe(workspace);
          expect(config.agents.defaults.skipBootstrap).toBe(true);
          expect((await fs.readdir(workspace)).filter((name) => name.endsWith(".md"))).toEqual([]);
        } else {
          expect(runtime.exit).toHaveBeenCalledWith(1);
          expect(runtime.error).toHaveBeenCalledWith(
            expect.stringContaining("openclaw doctor --fix"),
          );
          expect(await readConfig()).toBe(rootRaw);
          await expect(fs.stat(workspace)).rejects.toMatchObject({ code: "ENOENT" });
        }
        expect(await readInclude()).toBe(includeRaw);
      });
    },
  );

  it("persists a roster when existing setup settings already match", async () => {
    await withSetupHome(async (home, { runtime, writeConfig, readConfig }) => {
      const workspace = path.join(home, "workspace");
      await writeConfig({ agents: { defaults: { workspace } }, gateway: { mode: "local" } });

      await setupCommand(undefined, runtime);

      const config = JSON.parse(await readConfig()) as OpenClawConfig;
      expect(config.agents?.entries).toEqual({ main: {} });
    });
  });

  it.each([false, true])(
    "rejects a foreign write before the final config commit (fresh: %s)",
    async (fresh) => {
      await withSetupHome(async (home, { runtime, configDir, configPath }) => {
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
        effects.replaceConfigFile.mockImplementationOnce(async (params) => {
          // The facade export is setup's final replace, not first-agent creation's transform.
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
        // Fresh creation may already provision files; failure must stop subsequent setup effects.
        expect(effects.ensureAgentWorkspace).toHaveBeenCalledTimes(beforeFinalWrite.workspace);
        expect(effects.resolveSessionTranscriptsDir).toHaveBeenCalledTimes(
          beforeFinalWrite.sessions,
        );
        expect(sessionMkdirCalls()).toBe(beforeFinalWrite.mkdir);
      });
    },
  );

  it.each([
    { label: "malformed", raw: '{ "gateway": ', json: true },
    { label: "array root", raw: "[]", json: false },
  ])("preserves $label config and stops before setup mutations", async ({ raw, json }) => {
    await withSetupHome(async (home, { runtime, configDir, configPath }) => {
      const effects = await observeSetupOwners();
      const original = Buffer.from(raw, "utf-8");
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
      }
      expect(await fs.readFile(configPath)).toStrictEqual(original);
      expectNoSetupEffects(effects, home);
    });
  });

  it("gives an actionable error when baseline setup has no ambient owner", async () => {
    await withSetupHome(async (_home, { runtime, writeConfig }) => {
      const effects = await observeSetupOwners();
      const preexisting: OpenClawConfig = {
        agents: {
          ownership: "explicit",
          entries: { "agent-a": {}, "agent-b": {} },
        },
        gateway: { mode: "local" },
      };

      await writeConfig(preexisting);

      await expect(setupCommand(undefined, runtime)).rejects.toThrow(
        "Multiple agents are configured, but baseline setup has no explicit owner. Set agents.defaults.systemAgent.agentId.",
      );
      expect(effects.ensureAgentWorkspace).not.toHaveBeenCalled();
      expect(effects.resolveSessionTranscriptsDir).not.toHaveBeenCalled();
    });
  });
});
