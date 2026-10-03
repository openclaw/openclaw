import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readAgentRosterProperty } from "../agents/agent-roster.js";
import { resolveAgentWorkspaceDir } from "../agents/agent-scope-config.js";
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
import { prepareAutomaticHeartbeatRepair } from "./doctor-automatic-heartbeat-repair.js";
import {
  prepareDoctorContext,
  withDoctorConfigMaintenance,
} from "./doctor-config-flow.test-support.js";
import { withDoctorConfigPreflightHome } from "./doctor-config-preflight.test-support.js";

describe("Doctor workspace persistence", () => {
  it.each(["admitted", "external", "included", "newer", "unrelated-invalid"] as const)(
    "admits only complete updater heartbeat normalization (%s)",
    async (boundary) => {
      await withDoctorConfigPreflightHome(async (home) => {
        await withEnvAsync(
          {
            OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
            OPENCLAW_UPDATE_IN_PROGRESS: "1",
            OPENCLAW_UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE: "1",
            OPENCLAW_CONFIG_READONLY: boundary === "external" ? "1" : undefined,
            OPENCLAW_ALLOW_OLDER_BINARY_DESTRUCTIVE_ACTIONS: undefined,
          },
          async () => {
            const agents = {
              defaults: { heartbeat: { every: "30m" } },
              entries: { main: { workspace: path.join(home, "workspace") } },
            };
            const configPath = await writeOpenClawConfig(home, {
              ...(boundary === "newer" ? { meta: { lastTouchedVersion: "9999.1.1" } } : {}),
              agents: boundary === "included" ? { $include: "agents.json" } : agents,
              gateway: {
                mode: "local",
                ...(boundary === "unrelated-invalid" ? { port: "bad" } : {}),
              },
              plugins: { enabled: false },
            });
            if (boundary === "included") {
              await fs.writeFile(
                path.join(path.dirname(configPath), "agents.json"),
                JSON.stringify(agents),
              );
            }
            const original = await fs.readFile(configPath, "utf8");
            const admission = await prepareAutomaticHeartbeatRepair({ nonInteractive: true });
            expect(Boolean(admission)).toBe(boundary === "admitted");
            expect(await fs.readFile(configPath, "utf8")).toBe(original);
            expect(admission?.snapshot.sourceConfig.agents?.defaults?.heartbeat).toEqual(
              boundary === "admitted" ? { every: "30m" } : undefined,
            );
          },
        );
      });
    },
  );

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
          session: { typingMode: "thinking", parentForkMaxTokens: 200_000 },
          browser: { relayBindHost: "127.0.0.1", ssrfPolicy: { allowPrivateNetwork: true } },
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
          await runInitialConfigWriteHealth(await prepareDoctorContext(configPath));
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
        const canonical = ["discord:100000000000000001", "telegram:123", "slack:U123"];
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
        const ctx = await prepareDoctorContext(configPath);
        for (const index of [0, 1, 2]) {
          expect(ctx.configResult.pendingChangePanels?.join("\n")).toContain(
            `commands.ownerAllowFrom[${index}]`,
          );
        }
        await runInitialConfigWriteHealth(ctx);
        expect(ctx.configWriteRefusal).toBeUndefined();
        const saved = await readConfigFileSnapshot();
        expect(saved.config.commands?.ownerAllowFrom).toEqual([...canonical, ...preserved]);
        const bytes = await fs.readFile(configPath, "utf8");
        expect(JSON.parse(bytes).agents).toHaveProperty("entries.main");
        expect(JSON.parse(bytes).agents).not.toHaveProperty("list");
        const repeated = await prepareDoctorContext(configPath);
        expect(repeated.configResult.shouldWriteConfig).toBe(false);
        await runInitialConfigWriteHealth(repeated);
        expect(await fs.readFile(configPath, "utf8")).toBe(bytes);
      });
    });
  });

  it.each([
    ["entries", false],
    ["list", true],
  ] as const)(
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
                ...(shape === "entries"
                  ? { entries }
                  : {
                      list: Object.entries(entries).map(([id, entry]) =>
                        Object.assign({ id }, entry),
                      ),
                    }),
              },
              gateway: { mode: "local" },
              plugins: { enabled: false },
            });
            const original = await fs.readFile(configPath, "utf8");
            expect((await readConfigFileSnapshot()).valid).toBe(false);

            const ctx = await prepareDoctorContext(configPath);
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
            expect((await prepareDoctorContext(configPath)).configResult.shouldWriteConfig).toBe(
              false,
            );
          },
        );
      });
    },
  );

  it.each([
    { kind: "implicit", legacyId: "main" },
    { kind: "shared", legacyId: " Main " },
  ])(
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

            const ctx = await prepareDoctorContext(configPath);
            await runInitialConfigWriteHealth(ctx);
            const saved = await readConfigFileSnapshot();
            expect(saved.valid).toBe(true);
            expect(saved.config.agents?.ownership).toBe("explicit");
            expect(saved.config.agents?.entries?.main?.workspace).toBe(workspace);
            expect(saved.config.agents?.defaults?.systemAgent).toEqual({ agentId: "main" });
            expect(saved.config.agents?.defaults?.heartbeat).toBeUndefined();
            expect(saved.config.bindings).toBeUndefined();
            expect(resolveAgentWorkspaceDir(saved.config, "main")).toBe(workspace);
            for (const [name, content] of Object.entries(originals)) {
              expect(await fs.readFile(path.join(workspace, name), "utf8")).toBe(content);
            }
            expect((await prepareDoctorContext(configPath)).configResult.shouldWriteConfig).toBe(
              false,
            );
          },
        );
      });
    },
  );

  it("retains malformed heartbeat hours when durable migration refuses retirement", async () => {
    await withDoctorConfigPreflightHome(async (home) => {
      await withEnvAsync({ OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" }, async () => {
        const heartbeat = { every: "30m", activeHours: { start: "99:99", end: "17:00" } };
        const configPath = await writeOpenClawConfig(home, {
          agents: { list: [{ id: " Ops ", workspace: null, heartbeat }] },
          gateway: { mode: "local" },
          plugins: { enabled: false },
        });
        const original = await fs.readFile(configPath, "utf8");
        expect((await readConfigFileSnapshot()).valid).toBe(false);

        await expect(prepareDoctorContext(configPath)).rejects.toThrow("activeHours");

        expect(await fs.readFile(configPath, "utf8")).toBe(original);
        const saved = await readConfigFileSnapshot();
        expect(saved.valid).toBe(false);
        expect(readAgentRosterProperty(saved.sourceConfig)).toMatchObject({
          kind: "list",
          value: [{ heartbeat }],
        });
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
        const ctx = await prepareDoctorContext(configPath);

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
              const ctx = await prepareDoctorContext(configPath);
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
            expect.soft(rows).toHaveLength(2);
            expect.soft(rows[0]?.agent_id).toBe("main");
            expect
              .soft(
                rows.map((row) => JSON.parse(row.job_json)),
                `pass ${pass}`,
              )
              .toMatchObject([
                {
                  id: "retained-owner",
                  agentId: "main",
                  payload: { model: "openai/gpt-5.6-sol" },
                },
                {
                  agentId: "ops",
                  payload: { kind: "agentTurn" },
                  delivery: { mode: "announce", target: "owner" },
                },
              ]);
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

  it.each(["parsed", "prefixed"])(
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
              await runInitialConfigWriteHealth(await prepareDoctorContext(configPath));
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
