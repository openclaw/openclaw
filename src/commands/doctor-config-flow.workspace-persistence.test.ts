import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readAgentRosterProperty } from "../agents/agent-roster.js";
import { resolveAgentWorkspaceDir } from "../agents/agent-scope-config.js";
import { listConfiguredOwnerInputs } from "../agents/prepared-model-runtime.configured.js";
import { promoteConfigSnapshotToLastKnownGood, readConfigFileSnapshot } from "../config/config.js";
import { writeOpenClawConfig } from "../config/test-helpers.js";
import { makeCronJob } from "../cron/delivery.test-helpers.js";
import { saveCronJobsStore } from "../cron/store.js";
import { cronStoreKey } from "../cron/store/key.js";
import { loadCronRows } from "../cron/store/row-codec.js";
import {
  runInitialConfigWriteHealth,
  runWriteConfigHealth,
} from "../flows/doctor-health-contribution-runners.config.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { withEnvAsync } from "../test-utils/env.js";
import {
  prepareDoctorContext,
  withDoctorConfigMaintenance,
} from "./doctor-config-flow.test-support.js";
import { withDoctorConfigPreflightHome } from "./doctor-config-preflight.test-support.js";

describe("Doctor workspace persistence", () => {
  afterEach(() => {
    closeOpenClawStateDatabaseForTest();
  });

  it("refuses retired config until the bridge release migrates it", async () => {
    await withDoctorConfigPreflightHome(async (home) => {
      await withEnvAsync({ OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" }, async () => {
        const configPath = await writeOpenClawConfig(home, {
          heartbeat: { every: "30m" },
          agents: {
            defaults: {
              systemPromptOverride: "custom prompt",
              silentReplyRewrite: true,
              silentReply: { direct: true },
              model: { primary: "openai/gpt-5.6-sol", timeoutMs: 20_000 },
              subagents: { model: { primary: "openai/gpt-5.6-sol", timeoutMs: 10_000 } },
            },
            entries: {
              ops: {
                embeddedPi: {},
                embeddedHarness: {},
                agentRuntime: {},
                sandbox: { perSession: true },
                memorySearch: { store: { path: "old.sqlite" } },
                model: { primary: "openai/gpt-5.6-sol", timeoutMs: 20_000 },
                subagents: { model: { primary: "openai/gpt-5.6-sol", timeoutMs: 10_000 } },
              },
            },
          },
          models: {
            providers: {
              custom: {
                api: "openai-codex-responses",
                models: [{ id: "legacy-model", api: "openai-codex-responses" }],
              },
            },
          },
          session: { typingMode: "thinking", parentForkMaxTokens: 200_000 },
          browser: {
            relayBindHost: "127.0.0.1",
            ssrfPolicy: { allowPrivateNetwork: true },
            profiles: { relay: { driver: "extension", cdpUrl: "http://127.0.0.1:18792" } },
          },
          messages: {
            queue: {
              mode: "queue",
              byChannel: { discord: "steer-backlog", slack: "steer+backlog" },
            },
          },
          gatway: { port: 12345 },
          gateway: { mode: "local", webchat: { chatHistoryMaxChars: 48_000 } },
          plugins: { enabled: false },
        });
        const original = await fs.readFile(configPath, "utf8");
        expect((await readConfigFileSnapshot()).valid).toBe(false);
        const repair = (async () => {
          await using ctx = await prepareDoctorContext(configPath);
          await runInitialConfigWriteHealth(ctx);
        })();
        for (const setting of [
          "heartbeat",
          "systemPromptOverride",
          "silentReplyRewrite",
          "silentReply.direct",
          "embeddedPi",
          "embeddedHarness",
          "agentRuntime",
          "sandbox.perSession",
          "memorySearch.store.path",
          "agents.defaults.model.timeoutMs",
          "agents.defaults.subagents.model.timeoutMs",
          "agents.entries.ops.model.timeoutMs",
          "agents.entries.ops.subagents.model.timeoutMs",
          "parentForkMaxTokens",
          "relayBindHost",
          "browser.profiles.relay.cdpUrl",
          "models.providers.custom.api",
          "models.providers.custom.models.0.api",
          "allowPrivateNetwork",
          "messages.queue.mode",
          "messages.queue.byChannel.discord",
          "messages.queue.byChannel.slack",
          "gateway.webchat",
          "2026.9.5",
          "openclaw doctor --fix",
          "latest",
        ]) {
          await expect.soft(repair).rejects.toThrow(setting);
        }
        expect.soft(await fs.readFile(configPath, "utf8")).toBe(original);
        expect.soft((await readConfigFileSnapshot()).valid).toBe(false);
      });
    });
  });

  it("upgrades the oldest supported July config and persists it only once", async () => {
    await withDoctorConfigPreflightHome(async (home) => {
      await withEnvAsync({ OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" }, async () => {
        const preserved = [
          "discord:100000000000000002",
          "matrix:@owner:example.org",
          "slack:team:T123:user:U456",
          "unknown:user:123",
          "discord:user:user:123",
          "discord:user:",
          "discord:user:*",
          "123",
          456,
        ];
        // Unavailable channel contracts cannot prove it is safe to drop a target kind.
        const canonical = [
          "discord:user:100000000000000001",
          "telegram:user:123",
          "slack:user:U123",
        ];
        const configPath = await writeOpenClawConfig(home, {
          // v2026.7.1-beta.1 (published July 2 UTC) admits this roster and ownerAllowFrom shape.
          meta: { lastTouchedVersion: "2026.7.1-beta.1" },
          agents: { list: [{ id: "main" }] },
          commands: {
            ownerAllowFrom: [
              "discord:user:100000000000000001",
              "telegram:user:123",
              "slack:user:U123",
              ...preserved,
            ],
          },
          gateway: { mode: "local" },
          plugins: { enabled: false },
        });
        await using ctx = await prepareDoctorContext(configPath);
        await runInitialConfigWriteHealth(ctx);
        expect(ctx.configWriteRefusal).toBeUndefined();
        const saved = await readConfigFileSnapshot();
        expect(saved.config.commands?.ownerAllowFrom).toEqual([...canonical, ...preserved]);
        const bytes = await fs.readFile(configPath, "utf8");
        expect(JSON.parse(bytes).agents).toHaveProperty("entries.main");
        expect(JSON.parse(bytes).agents).not.toHaveProperty("list");
        await using repeated = await prepareDoctorContext(configPath);
        expect(repeated.configResult.shouldWriteConfig).toBe(false);
        await runInitialConfigWriteHealth(repeated);
        expect(await fs.readFile(configPath, "utf8")).toBe(bytes);
      });
    });
  });

  it.each([["list", true]] as const)(
    "persists per-agent migrations with explicit ownership (%s, writable update: %s)",
    async (shape, writableUpdate) => {
      await withDoctorConfigPreflightHome(async (home) => {
        await withEnvAsync(
          {
            OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
            OPENCLAW_UPDATE_IN_PROGRESS: writableUpdate ? "1" : undefined,
            OPENCLAW_UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE: writableUpdate ? "1" : undefined,
          },
          async () => {
            const entries = {
              ops: {
                memorySearch: { enabled: false, extraPaths: [path.join(home, "notes")] },
                sandbox: { scope: "agent", browser: { enableNoVnc: true } },
                embeddedAgent: { executionContract: "default" },
                model: { primary: "openai/gpt-5.6-sol" },
              },
              research: { memory: { search: { provider: "auto" } } },
            };
            const configPath = await writeOpenClawConfig(home, {
              meta: { migrations: { webhookListeners: true } },
              agents: {
                ownership: "explicit",
                defaults: {
                  embeddedAgent: { projectSettingsPolicy: "trusted" },
                  sandbox: { scope: "shared" },
                },
                list: Object.entries(entries).map(([id, entry]) => Object.assign({ id }, entry)),
              },
              gateway: { mode: "local" },
              plugins: { enabled: false },
            });
            const original = await fs.readFile(configPath, "utf8");
            expect((await readConfigFileSnapshot()).valid).toBe(false);

            await using ctx = await prepareDoctorContext(configPath);
            await runInitialConfigWriteHealth(ctx);
            expect(ctx.configWriteRefusal).toBeUndefined();
            expect(await fs.readFile(`${configPath}.bak`, "utf8")).toBe(original);

            const saved = JSON.parse(await fs.readFile(configPath, "utf-8"));
            expect(saved.agents.entries.ops).toEqual({
              memory: { search: entries.ops.memorySearch },
              sandbox: { scope: "agent", browser: { noVncEnabled: true } },
              embeddedAgent: { executionContract: "default" },
              model: { primary: "openai/gpt-5.6-sol" },
            });
            expect(saved.agents.ownership).toBe("explicit");
            expect(saved.agents.defaults).toMatchObject({
              embeddedAgent: {
                projectSettingsPolicy: "trusted",
              },
              sandbox: { scope: "shared" },
            });
            expect(saved.gateway).toEqual({ mode: "local" });
            expect(saved.agents.entries.research).toEqual({
              memory: { search: { provider: "openai" } },
            });
            expect((await readConfigFileSnapshot()).valid).toBe(true);
            await using repeated = await prepareDoctorContext(configPath);
            expect(repeated.configResult.shouldWriteConfig).toBe(false);
          },
        );
      });
    },
  );

  it.each([{ kind: "shared", legacyId: " Main " }])(
    "preserves the markerless $legacyId agent's $kind workspace through Doctor persistence",
    async ({ kind, legacyId }) => {
      await withDoctorConfigPreflightHome(async (home) => {
        await withEnvAsync(
          { OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1", OPENCLAW_WORKSPACE_DIR: undefined },
          async () => {
            const workspace = path.join(
              home,
              kind === "shared" ? "shared-workspace" : ".openclaw/workspace",
            );
            await fs.mkdir(path.join(workspace, "memory"), { recursive: true });
            const originals = {
              "AGENTS.md": "# Existing agent\n\nKeep the original workspace.\n",
              "SOUL.md": "# Existing character\n",
              "IDENTITY.md": "# Original identity\n",
              "USER.md": "# Original preferences\n",
              "MEMORY.md": "# Original durable memory\n",
              "memory/2026-07-01.md": "Historical memory remains in this workspace.\n",
            };
            for (const [name, content] of Object.entries(originals)) {
              await fs.writeFile(path.join(workspace, name), content);
            }
            const configPath = await writeOpenClawConfig(home, {
              agents: {
                ...(kind === "shared" ? { defaults: { workspace } } : {}),
                list: [{ id: legacyId }, { id: "other" }],
              },
              gateway: { mode: "local" },
              plugins: { enabled: false },
            });
            const before = await readConfigFileSnapshot();
            expect(before.valid).toBe(false);
            expect(readAgentRosterProperty(before.sourceConfig)).toEqual({
              kind: "list",
              value: [{ id: legacyId }, { id: "other" }],
            });

            await using ctx = await prepareDoctorContext(configPath);
            await runInitialConfigWriteHealth(ctx);
            const saved = await readConfigFileSnapshot();
            expect(saved.valid).toBe(true);
            expect(saved.config.agents?.ownership).toBe("explicit");
            expect(saved.config.agents?.entries?.main?.workspace).toBe(workspace);
            expect(saved.config.agents?.defaults?.systemAgent).toEqual({ agentId: "main" });
            expect(saved.config.agents?.defaults?.heartbeat).toEqual({ agentId: "main" });
            expect(saved.config.bindings).toBeUndefined();
            expect(resolveAgentWorkspaceDir(saved.config, "main")).toBe(workspace);
            for (const [name, content] of Object.entries(originals)) {
              expect(await fs.readFile(path.join(workspace, name), "utf8")).toBe(content);
            }
            await using repeated = await prepareDoctorContext(configPath);
            expect(repeated.configResult.shouldWriteConfig).toBe(false);
          },
        );
      });
    },
  );

  it("repairs noncanonical workspace and heartbeat values through persistence", async () => {
    await withDoctorConfigPreflightHome(async (home) => {
      await withEnvAsync({ OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" }, async () => {
        const agent = {
          workspace: null,
          heartbeat: { every: "30m", activeHours: { start: "99:99", end: "17:00" } },
        };
        const configPath = await writeOpenClawConfig(home, {
          agents: { list: [{ id: " Ops ", ...agent }] },
          gateway: { mode: "local" },
          plugins: { enabled: false },
        });
        const before = await readConfigFileSnapshot();
        expect(before.valid).toBe(false);
        expect(readAgentRosterProperty(before.sourceConfig)?.value).toHaveLength(1);

        await using ctx = await prepareDoctorContext(configPath);
        expect(ctx.configResult.shouldWriteConfig).toBe(true);
        expect(ctx.cfg.agents?.entries?.ops).toEqual({ heartbeat: { every: "30m" } });
        await runInitialConfigWriteHealth(ctx);

        const saved = JSON.parse(await fs.readFile(configPath, "utf-8"));
        expect(saved.agents.entries.ops).toEqual({ heartbeat: { every: "30m" } });
        expect(saved.agents).not.toHaveProperty("list");
        expect((await readConfigFileSnapshot()).valid).toBe(true);
        await using repeated = await prepareDoctorContext(configPath);
        expect(repeated.configResult.shouldWriteConfig).toBe(false);
      });
    });
  });

  it("keeps the legacy owner on the shared workspace across later health writes", async () => {
    await withDoctorConfigPreflightHome(async (home) => {
      await withEnvAsync({ OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" }, async () => {
        const workspace = path.join(home, "shared-workspace");
        const configPath = await writeOpenClawConfig(home, {
          agents: {
            defaults: { workspace },
            entries: { main: { default: true }, cursor: { workspace } },
          },
          gateway: { mode: "local" },
          plugins: { enabled: false },
        });
        await using ctx = await prepareDoctorContext(configPath);

        await runInitialConfigWriteHealth(ctx);
        expect((await readConfigFileSnapshot()).config.agents?.entries?.main?.workspace).toBe(
          workspace,
        );

        ctx.cfg = { ...ctx.cfg, gateway: { ...ctx.cfg.gateway, bind: "lan" } };
        await runWriteConfigHealth(ctx);

        const snapshot = await readConfigFileSnapshot();
        expect(snapshot.valid).toBe(true);
        expect(snapshot.config.agents?.ownership).toBe("explicit");
        expect(snapshot.config.agents?.entries?.main?.workspace).toBe(workspace);
      });
    });
  });

  it("does not pin a converged system agent whose files are only in the shared workspace", async () => {
    await withDoctorConfigPreflightHome(async (home) => {
      await withEnvAsync({ OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" }, async () => {
        const workspace = path.join(home, "shared-workspace");
        await fs.mkdir(path.join(workspace, "memory"), { recursive: true });
        await fs.writeFile(path.join(workspace, "SOUL.md"), "root persona");
        const configPath = await writeOpenClawConfig(home, {
          agents: {
            ownership: "explicit",
            defaults: { workspace, systemAgent: { agentId: "main" } },
            entries: { main: {}, dev: {} },
          },
          gateway: { mode: "local" },
          plugins: { enabled: false },
        });
        const before = (await readConfigFileSnapshot()).config;
        expect(resolveAgentWorkspaceDir(before, "main")).toBe(path.join(workspace, "main"));

        await runInitialConfigWriteHealth(await prepareDoctorContext(configPath));

        const after = (await readConfigFileSnapshot()).config;
        expect(after.agents?.entries?.main?.workspace).toBeUndefined();
        expect(resolveAgentWorkspaceDir(after, "main")).toBe(path.join(workspace, "main"));
        expect(await fs.readFile(path.join(workspace, "SOUL.md"), "utf8")).toBe("root persona");
      });
    });
  });

  it("pins a converged system agent to its directory and keeps the authored env root", async () => {
    await withDoctorConfigPreflightHome(async (home) => {
      const workspace = path.join(home, "shared-workspace");
      await withEnvAsync(
        { OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1", WORKSPACE_ROOT: workspace },
        async () => {
          await fs.mkdir(path.join(workspace, "main", "memory"), { recursive: true });
          await fs.writeFile(path.join(workspace, "main", "SOUL.md"), "agent persona");
          const configPath = await writeOpenClawConfig(home, {
            agents: {
              ownership: "explicit",
              defaults: { workspace: "${WORKSPACE_ROOT}", systemAgent: { agentId: "main" } },
              entries: { main: {}, dev: {} },
            },
            gateway: { mode: "local" },
            plugins: { enabled: false },
          });

          await runInitialConfigWriteHealth(await prepareDoctorContext(configPath));

          const written = JSON.parse(await fs.readFile(configPath, "utf8")) as {
            agents: { defaults: { workspace: string }; entries: Record<string, any> };
          };
          expect(written.agents.defaults.workspace).toBe("${WORKSPACE_ROOT}");
          expect(written.agents.entries.main.workspace).toBe("${WORKSPACE_ROOT}/main");
          const after = (await readConfigFileSnapshot()).config;
          expect(resolveAgentWorkspaceDir(after, "main")).toBe(path.join(workspace, "main"));
          const launch = listConfiguredOwnerInputs(after, workspace).find(
            (input) => input.agentId === "main",
          );
          expect(launch?.workspaceDir).toBe(path.join(workspace, "main"));
          expect(resolveAgentWorkspaceDir(after, "dev")).toBe(path.join(workspace, "dev"));
        },
      );
    });
  });

  it("keeps the authored env root when agents.defaults comes from an include", async () => {
    await withDoctorConfigPreflightHome(async (home) => {
      const workspace = path.join(home, "shared-workspace");
      const moved = path.join(home, "moved-workspace");
      await withEnvAsync(
        { OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1", WORKSPACE_ROOT: workspace },
        async () => {
          await fs.mkdir(path.join(workspace, "main", "memory"), { recursive: true });
          await fs.writeFile(path.join(workspace, "main", "SOUL.md"), "agent persona");
          await fs.mkdir(path.join(home, ".openclaw"), { recursive: true });
          await fs.writeFile(
            path.join(home, ".openclaw", "defaults.json5"),
            '{ workspace: "${WORKSPACE_ROOT}", systemAgent: { agentId: "main" } }\n',
          );
          const configPath = await writeOpenClawConfig(home, {
            agents: {
              ownership: "explicit",
              defaults: { $include: "./defaults.json5" },
              entries: { main: {}, dev: {} },
            },
            gateway: { mode: "local" },
            plugins: { enabled: false },
          });

          await runInitialConfigWriteHealth(await prepareDoctorContext(configPath));

          const written = JSON.parse(await fs.readFile(configPath, "utf8")) as {
            agents: { defaults: Record<string, unknown>; entries: Record<string, any> };
          };
          expect(written.agents.defaults).toEqual({ $include: "./defaults.json5" });
          expect(written.agents.entries.main.workspace).toBe("${WORKSPACE_ROOT}/main");
          const after = (await readConfigFileSnapshot()).config;
          expect(resolveAgentWorkspaceDir(after, "main")).toBe(path.join(workspace, "main"));
          expect(resolveAgentWorkspaceDir(after, "dev")).toBe(path.join(workspace, "dev"));

          process.env.WORKSPACE_ROOT = moved;
          const reloaded = (await readConfigFileSnapshot()).config;
          expect(resolveAgentWorkspaceDir(reloaded, "main")).toBe(path.join(moved, "main"));
          expect(resolveAgentWorkspaceDir(reloaded, "dev")).toBe(path.join(moved, "dev"));
        },
      );
    });
  });

  it("persists cron runtime policy on the retained owner before rewriting its model", async () => {
    await withDoctorConfigPreflightHome(async (home) => {
      const stateDir = path.join(home, ".openclaw");
      await withEnvAsync(
        { OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1", OPENCLAW_STATE_DIR: stateDir },
        async () => {
          const configPath = await writeOpenClawConfig(home, {
            agents: {
              defaults: { systemAgent: { agentId: "ops" } },
              entries: { main: { default: true }, ops: {} },
            },
            gateway: { mode: "local" },
            plugins: { enabled: false },
          });
          const storePath = path.join(stateDir, "cron", "jobs.json");
          await saveCronJobsStore(storePath, {
            version: 1,
            jobs: [
              makeCronJob({
                id: "retained-owner",
                enabled: false,
                payload: {
                  kind: "agentTurn",
                  message: "Do not run this disabled job",
                  model: "codex/gpt-5.6-sol",
                },
              }),
            ],
          });
          const seededRows = loadCronRows(openOpenClawStateDatabase().db, cronStoreKey(storePath));
          expect(seededRows).toHaveLength(1);
          expect(seededRows[0]?.agent_id).toBeNull();
          const seededJob: unknown = JSON.parse(seededRows[0]!.job_json);
          expect(seededJob).not.toHaveProperty("agentId");
          expect(seededJob).toMatchObject({ payload: { model: "codex/gpt-5.6-sol" } });

          let firstPolicies: unknown;
          let firstRows: unknown;
          for (const pass of [1, 2]) {
            await withDoctorConfigMaintenance(async () => {
              await using ctx = await prepareDoctorContext(configPath);
              await runInitialConfigWriteHealth(ctx);
              await runWriteConfigHealth(ctx);
            });
            const snapshot = await readConfigFileSnapshot();
            const policies = {
              main: snapshot.config.agents?.entries?.main?.models,
              ops: snapshot.config.agents?.entries?.ops?.models,
            };
            const rows = loadCronRows(openOpenClawStateDatabase().db, cronStoreKey(storePath));
            expect.soft(snapshot.valid, `pass ${pass}`).toBe(true);
            expect.soft(snapshot.config.agents?.defaults?.systemAgent?.agentId).toBe("ops");
            expect.soft(policies, `pass ${pass}`).toEqual({
              main: { "openai/gpt-5.6-sol": { agentRuntime: { id: "codex" } } },
              ops: undefined,
            });
            expect.soft(rows).toHaveLength(1);
            expect.soft(rows[0]?.agent_id).toBe("main");
            expect
              .soft(
                rows.map((row) => JSON.parse(row.job_json)),
                `pass ${pass}`,
              )
              .toMatchObject([{ agentId: "main", payload: { model: "openai/gpt-5.6-sol" } }]);
            if (pass === 2) {
              expect.soft(policies).toEqual(firstPolicies);
              expect.soft(rows).toEqual(firstRows);
            }
            firstPolicies = policies;
            firstRows = rows;
          }
        },
      );
    });
  });

  it.each(["prefixed"])(
    "refuses retired Talk selectors in %s config before recovery",
    async (kind) => {
      await withDoctorConfigPreflightHome(async (home) => {
        await withEnvAsync({ OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" }, async () => {
          const canonical = {
            talk: { realtime: { provider: "openai", speakerVoice: "marin" } },
            gateway: { mode: "local" },
            plugins: { enabled: false },
          };
          const configPath = await writeOpenClawConfig(home, canonical);
          expect(await promoteConfigSnapshotToLastKnownGood(await readConfigFileSnapshot())).toBe(
            true,
          );
          const backup = await fs.readFile(configPath, "utf8");
          await fs.writeFile(`${configPath}.bak`, backup);
          const retired = {
            ...canonical,
            talk: {
              ...canonical.talk,
              mode: "realtime",
              transport: "gateway-relay",
              brain: "agent-consult",
              model: "gpt-realtime",
              voice: "alloy",
            },
          };
          const original = `${kind === "prefixed" ? "Found and updated: False\n" : ""}${JSON.stringify(retired)}\n`;
          await fs.writeFile(configPath, original);
          await expect
            .soft(async () => {
              await using ctx = await prepareDoctorContext(configPath);
              await runInitialConfigWriteHealth(ctx);
            })
            .rejects.toThrow(
              /talk\.mode, talk\.transport, talk\.brain, talk\.model, talk\.voice[\s\S]*2026\.9\.5[\s\S]*openclaw doctor --fix/,
            );
          expect.soft(await fs.readFile(configPath, "utf8")).toBe(original);
          expect.soft(await fs.readFile(`${configPath}.bak`, "utf8")).toBe(backup);
          expect.soft(await fs.readFile(`${configPath}.last-good`, "utf8")).toBe(backup);
        });
      });
    },
  );
});
