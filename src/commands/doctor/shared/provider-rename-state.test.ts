import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadPersistedAuthProfileStore } from "../../../agents/auth-profiles/persisted.js";
import {
  loadSessionEntry,
  replaceSessionEntry,
} from "../../../config/sessions/session-accessor.js";
import type { SessionEntry } from "../../../config/sessions/types.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { makeCronJob } from "../../../cron/delivery.test-helpers.js";
import { loadCronJobsStore, saveCronJobsStore } from "../../../cron/store.js";
import { acquireGatewayStateOwner } from "../../../infra/gateway-state-owner.js";
import { createOpenClawDatabaseMaintenanceScope } from "../../../state/openclaw-state-db-async-lifecycle.js";
import { openOpenClawStateDatabase } from "../../../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import { inspectCronJobsForDoctor } from "../cron/store-repair.js";
import { maybeRepairCodexSessionRoutes } from "./codex-route-session-repair.js";
import { resolveDoctorProviderRenames } from "./provider-rename-recovery.js";
import { maybeRepairProviderRenameCronJobs } from "./provider-rename-state.js";
import { applyProviderRenames, type ProviderRename } from "./provider-rename.js";

const renames: readonly ProviderRename[] = [
  { from: "ollama", to: "ollama-cloud", baseUrl: "https://ollama.com" },
];

describe("persisted provider rename", () => {
  it("resumes after config publication and repairs all cron partitions with a backup", async () => {
    await withOpenClawTestState({ label: "provider-rename-cron" }, async (state) => {
      const source: OpenClawConfig = {
        plugins: { enabled: false },
        agents: { entries: { main: {} } },
        cron: { store: state.statePath("cron", "jobs.json") },
        models: {
          providers: {
            ollama: {
              baseUrl: "https://ollama.com",
              api: "ollama",
              apiKey: { source: "env", provider: "default", id: "OLLAMA_API_KEY" },
              models: [],
            },
          },
        },
      };
      const sessionScope = {
        storePath: path.join(state.sessionsDir(), "sessions.json"),
        sessionKey: "agent:main:resume",
        env: state.env,
      };
      await replaceSessionEntry(sessionScope, {
        sessionId: "resume",
        updatedAt: 1,
        modelProvider: "ollama",
        model: "model:cloud",
        providerOverride: "ollama",
        modelOverride: "fallback:cloud",
        authProfileOverride: "ollama:account",
        agentRuntimeOverride: "openclaw",
      });
      const sessionBefore = loadSessionEntry(sessionScope);
      for (const [partition, enabled] of [
        ["cron", true],
        ["inactive-cron", false],
      ] as const) {
        await saveCronJobsStore(state.statePath(partition, "jobs.json"), {
          version: 1,
          jobs: [
            makeCronJob({
              id: "rename",
              enabled,
              payload: {
                kind: "agentTurn",
                message: "Do not rewrite ollama/message",
                model: "ollama/model:cloud@ollama:saved-profile",
                fallbacks: ["ollama/fallback", "custom/unchanged"],
              },
              state: { lastRunAtMs: 123, lastRunStatus: "ok" },
            }),
            makeCronJob({
              id: "untouched",
              payload: { kind: "agentTurn", message: "keep", model: "custom/model" },
            }),
          ],
        });
      }
      const cfg = applyProviderRenames(source, renames).config;
      await state.writeConfig(source);
      // Preserve the source backup, then simulate interruption before either state repair.
      await fs.copyFile(state.configPath, `${state.configPath}.bak`);
      await expect(
        (async () => {
          await state.writeConfig(cfg);
          throw new Error("interrupted after config publication");
        })(),
      ).rejects.toThrow("interrupted after config publication");
      const published = JSON.parse(await fs.readFile(state.configPath, "utf8"));
      const recovered = resolveDoctorProviderRenames({
        config: published,
        snapshot: { path: state.configPath, parsed: published },
        declarations: renames,
      });
      expect(recovered.warnings).toEqual([]);
      expect(recovered.renames).toEqual(renames);
      const activeRenames = recovered.renames;
      const before = await inspectCronJobsForDoctor({ env: state.env });
      const db = openOpenClawStateDatabase();
      const backups = async () =>
        (await fs.readdir(path.dirname(db.path))).filter((name) =>
          name.startsWith(`${path.basename(db.path)}.doctor-cron-`),
        );
      expect(await backups()).toEqual([]);
      const preview = await maybeRepairProviderRenameCronJobs({
        cfg,
        renames: activeRenames,
        env: state.env,
        shouldRepair: false,
      });
      expect(preview.changes).toEqual([]);
      expect(preview.warnings.join("\n")).toContain("2 persisted cron job(s)");
      expect(await inspectCronJobsForDoctor({ env: state.env })).toEqual(before);
      expect(await backups()).toEqual([]);
      await maybeRepairCodexSessionRoutes({
        cfg,
        providerRenames: activeRenames,
        env: state.env,
        shouldRepair: false,
      });
      expect(loadSessionEntry(sessionScope)).toEqual(sessionBefore);

      const owner = acquireGatewayStateOwner({ databasePath: db.path });
      const maintenance = createOpenClawDatabaseMaintenanceScope({
        schemaMaintenance: true,
        assertOwnerCurrent: owner.assertCurrent,
        assertDatabaseAccess: owner.assertDatabaseAccess,
      });
      try {
        await maintenance.run(async () => {
          const result = await maybeRepairProviderRenameCronJobs({
            cfg,
            renames: activeRenames,
            env: state.env,
            shouldRepair: true,
          });
          expect(result.warnings).toEqual([]);
          expect(result.changes.join("\n")).toContain("2 persisted cron job(s)");
          expect(await backups()).toHaveLength(1);
          const after = await inspectCronJobsForDoctor({ env: state.env });
          expect(after.jobs).toHaveLength(4);
          for (const job of after.jobs) {
            const original = before.jobs.find(
              (candidate) => candidate.storeKey === job.storeKey && candidate.id === job.id,
            )!;
            if (job.id === "untouched") {
              expect(job).toEqual(original);
            } else {
              expect(job.definition).toEqual({
                ...original.definition,
                payload: {
                  kind: "agentTurn",
                  message: "Do not rewrite ollama/message",
                  model: "ollama-cloud/model:cloud",
                  fallbacks: ["ollama-cloud/fallback", "custom/unchanged"],
                },
              });
              expect(job.sortOrder).toBe(original.sortOrder);
            }
          }
          for (const partition of ["cron", "inactive-cron"]) {
            const store = await loadCronJobsStore(state.statePath(partition, "jobs.json"));
            expect(store.jobs.find((job) => job.id === "rename")?.state).toEqual({
              lastRunAtMs: 123,
              lastRunStatus: "ok",
            });
          }
          const sessionResult = await maybeRepairCodexSessionRoutes({
            cfg,
            providerRenames: activeRenames,
            env: state.env,
            shouldRepair: true,
          });
          expect(sessionResult.repairedSessions).toBe(1);
          expect(loadSessionEntry(sessionScope)).toEqual({
            ...sessionBefore,
            updatedAt: expect.any(Number),
            modelProvider: "ollama-cloud",
            providerOverride: "ollama-cloud",
          });
          const sessionAfter = loadSessionEntry(sessionScope);
          expect(
            await maybeRepairProviderRenameCronJobs({
              cfg,
              renames: activeRenames,
              env: state.env,
              shouldRepair: true,
            }),
          ).toEqual({ changes: [], warnings: [] });
          expect(
            (
              await maybeRepairCodexSessionRoutes({
                cfg,
                providerRenames: activeRenames,
                env: state.env,
                shouldRepair: true,
              })
            ).repairedSessions,
          ).toBe(0);
          expect(loadSessionEntry(sessionScope)).toEqual(sessionAfter);
          expect(JSON.parse(await fs.readFile(state.configPath, "utf8"))).toEqual(published);
          expect(JSON.parse(await fs.readFile(`${state.configPath}.bak`, "utf8"))).toEqual(source);
          expect(await backups()).toHaveLength(1);
        });
      } finally {
        await maintenance.close();
        owner.release();
      }
    });
  });

  it("repairs session pairs through the existing batch owner without touching auth or runtime", async () => {
    await withOpenClawTestState({ label: "provider-rename-sessions" }, async (state) => {
      const cfg: OpenClawConfig = {
        plugins: { enabled: false },
        agents: { entries: { main: {} } },
        models: {
          providers: {
            "ollama-cloud": { baseUrl: "https://ollama.com", api: "ollama", models: [] },
          },
        },
      };
      await state.writeConfig(cfg);
      const configBefore = await fs.readFile(state.configPath);
      const storePath = path.join(state.sessionsDir(), "sessions.json");
      const entries: Record<string, SessionEntry> = {
        paired: {
          sessionId: "paired",
          updatedAt: 1,
          modelProvider: "ollama",
          model: "model:cloud",
          providerOverride: "ollama",
          modelOverride: "other:cloud@ollama:account",
          agentRuntimeOverride: "openclaw",
          authProfileOverride: "ollama:account",
          authProfileOverrideSource: "user",
          modelOverrideSource: "user",
        },
        full: {
          sessionId: "full",
          updatedAt: 1,
          modelProvider: "ollama",
          model: "ollama/model:cloud",
          providerOverride: "ollama",
          modelOverride: "ollama/other:cloud@ollama:account",
          authProfileOverride: "ollama:account",
          agentRuntimeOverride: "openclaw",
        },
        unscoped: { sessionId: "unscoped", updatedAt: 1, model: "ollama/model:cloud" },
        unrelated: { sessionId: "unrelated", updatedAt: 1, model: "custom/keep" },
        custom: {
          sessionId: "custom",
          updatedAt: 1,
          modelProvider: "custom",
          model: "ollama/model:cloud",
          providerOverride: "custom",
          modelOverride: "ollama/other:cloud",
        },
      };
      for (const [id, entry] of Object.entries(entries)) {
        await replaceSessionEntry(
          { storePath, sessionKey: `agent:main:${id}`, env: state.env },
          entry,
        );
      }
      const readEntry = (id: string) =>
        loadSessionEntry({ storePath, sessionKey: `agent:main:${id}`, env: state.env });
      const before = Object.fromEntries(Object.keys(entries).map((id) => [id, readEntry(id)]));
      const args = { cfg, env: state.env, providerRenames: renames };
      const preview = await maybeRepairCodexSessionRoutes({ ...args, shouldRepair: false });
      expect(preview.repairedSessions).toBe(0);
      expect(preview.warnings.join("\n")).toContain("Affected sessions: 3");
      expect(Object.fromEntries(Object.keys(entries).map((id) => [id, readEntry(id)]))).toEqual(
        before,
      );
      const repaired = await maybeRepairCodexSessionRoutes({ ...args, shouldRepair: true });
      expect(repaired.repairedSessions).toBe(3);
      for (const id of ["paired", "full"]) {
        expect(readEntry(id)).toEqual({
          ...before[id],
          updatedAt: expect.any(Number),
          modelProvider: "ollama-cloud",
          model: id === "paired" ? "model:cloud" : "ollama-cloud/model:cloud",
          providerOverride: "ollama-cloud",
          modelOverride: id === "paired" ? "other:cloud" : "ollama-cloud/other:cloud",
        });
      }
      expect(readEntry("unscoped")).toEqual({
        ...before.unscoped,
        updatedAt: expect.any(Number),
        model: "ollama-cloud/model:cloud",
      });
      expect(readEntry("custom")).toEqual(before.custom);
      expect(readEntry("unrelated")).toEqual(before.unrelated);
      const after = Object.fromEntries(Object.keys(entries).map((id) => [id, readEntry(id)]));
      expect(
        (await maybeRepairCodexSessionRoutes({ ...args, shouldRepair: true })).repairedSessions,
      ).toBe(0);
      expect(Object.fromEntries(Object.keys(entries).map((id) => [id, readEntry(id)]))).toEqual(
        after,
      );
      expect(await fs.readFile(state.configPath)).toEqual(configBefore);
    });
  });
  it("selects saved Cloud accounts by session and cron owner without mutating credentials", async () => {
    await withOpenClawTestState({ label: "provider-rename-agent-accounts" }, async (state) => {
      const cfg: OpenClawConfig = {
        plugins: { enabled: false },
        agents: {
          defaults: { systemAgent: { agentId: "primary" } },
          entries: { primary: {}, work: {} },
        },
        models: {
          providers: {
            "ollama-cloud": { baseUrl: "https://ollama.com", api: "ollama", models: [] },
          },
        },
      };
      await state.writeConfig(cfg);
      const profilesByAgent = {
        primary: ["ollama-cloud:default", "ollama-cloud:personal"],
        work: ["ollama-cloud:work"],
        archived: ["ollama-cloud:archived"],
      };
      for (const [agentId, profileIds] of Object.entries(profilesByAgent)) {
        await state.writeAuthProfiles(
          {
            version: 1,
            profiles: Object.fromEntries(
              ["ollama:legacy", ...profileIds].map((id) => [
                id,
                {
                  type: "api_key",
                  provider: id === "ollama:legacy" ? "ollama" : "ollama-cloud",
                  key: `synthetic-${agentId}-${id}`,
                },
              ]),
            ),
          },
          agentId,
        );
      }
      const authBefore = Object.fromEntries(
        Object.keys(profilesByAgent).map((agentId) => [
          agentId,
          loadPersistedAuthProfileStore(state.agentDir(agentId)),
        ]),
      );
      const scopes = ["primary", "work"].map((agentId) => ({
        agentId,
        storePath: path.join(state.sessionsDir(agentId), "sessions.json"),
        sessionKey: `agent:${agentId}:account`,
        env: state.env,
      }));
      for (const scope of scopes) {
        await replaceSessionEntry(scope, {
          sessionId: `${scope.agentId}-account`,
          updatedAt: 1,
          modelProvider: "ollama",
          model: "primary@ollama:legacy",
          providerOverride: "ollama",
          modelOverride: "ollama/fallback@ollama-cloud:personal",
          authProfileOverride: "ollama:legacy",
          authProfileOverrideSource: "user",
          agentRuntimeOverride: "openclaw",
        });
      }
      const storePath = state.statePath("cron", "jobs.json");
      const jobs = [
        { id: "ownerless", expected: "ollama-cloud:default" },
        { id: "primary", agentId: "primary", expected: "ollama-cloud:personal" },
        { id: "work", sessionKey: "agent:work:cron", expected: "ollama-cloud:work" },
        { id: "archived", agentId: "archived", expected: "ollama-cloud:archived" },
      ];
      await saveCronJobsStore(storePath, {
        version: 1,
        jobs: jobs.map(({ expected: _expected, ...job }) =>
          makeCronJob({
            ...job,
            payload: {
              kind: "agentTurn",
              message: "Preserve authored text",
              model: `ollama/primary@${job.id === "ownerless" ? "ollama:legacy" : "ollama-cloud:personal"}`,
              fallbacks: ["ollama/fallback@ollama:legacy"],
            },
          }),
        ),
      });
      const sessionBefore = scopes.map((scope) => loadSessionEntry(scope));
      const cronBefore = await loadCronJobsStore(storePath);
      const database = openOpenClawStateDatabase();
      const owner = acquireGatewayStateOwner({ databasePath: database.path });
      const maintenance = createOpenClawDatabaseMaintenanceScope({
        schemaMaintenance: true,
        assertOwnerCurrent: owner.assertCurrent,
        assertDatabaseAccess: owner.assertDatabaseAccess,
      });
      try {
        await maintenance.run(async () => {
          const args = { cfg, env: state.env, shouldRepair: false };
          const cronPreview = await maybeRepairProviderRenameCronJobs({ ...args, renames });
          const sessionPreview = await maybeRepairCodexSessionRoutes({
            ...args,
            providerRenames: renames,
          });
          expect(cronPreview.warnings.join("\n")).toContain("ollama-cloud:archived");
          expect(sessionPreview.warnings.join("\n")).toContain("ollama-cloud:work");
          expect(scopes.map((scope) => loadSessionEntry(scope))).toEqual(sessionBefore);
          expect(await loadCronJobsStore(storePath)).toEqual(cronBefore);
          const cronResult = await maybeRepairProviderRenameCronJobs({
            ...args,
            renames,
            shouldRepair: true,
          });
          const sessionResult = await maybeRepairCodexSessionRoutes({
            ...args,
            providerRenames: renames,
            shouldRepair: true,
          });
          expect(cronResult.warnings).toEqual([]);
          expect(sessionResult.warnings).toEqual([]);
          expect(sessionResult.repairedSessions).toBe(2);
          for (const [index, scope] of scopes.entries()) {
            expect(loadSessionEntry(scope)).toEqual({
              ...sessionBefore[index],
              updatedAt: expect.any(Number),
              modelProvider: "ollama-cloud",
              model: `primary@ollama-cloud:${scope.agentId === "primary" ? "default" : "work"}`,
              providerOverride: "ollama-cloud",
              modelOverride: `ollama-cloud/fallback@ollama-cloud:${scope.agentId === "primary" ? "personal" : "work"}`,
            });
          }
          const repaired = await loadCronJobsStore(storePath);
          for (const job of jobs) {
            expect(repaired.jobs.find((entry) => entry.id === job.id)?.payload).toEqual({
              kind: "agentTurn",
              message: "Preserve authored text",
              model: `ollama-cloud/primary@${job.expected}`,
              fallbacks: [
                `ollama-cloud/fallback@${job.id === "primary" ? "ollama-cloud:default" : job.expected}`,
              ],
            });
          }
          for (const [agentId, before] of Object.entries(authBefore)) {
            expect(loadPersistedAuthProfileStore(state.agentDir(agentId))).toEqual(before);
          }
        });
      } finally {
        await maintenance.close();
        owner.release();
      }
    });
  });

  it("reports dropped and remapped state suffixes without changing saved credentials", async () => {
    await withOpenClawTestState({ label: "provider-rename-suffixes" }, async (state) => {
      const cfg: OpenClawConfig = {
        plugins: { enabled: false },
        agents: { entries: { main: {} } },
        models: {
          providers: {
            "ollama-cloud": { baseUrl: "https://ollama.com", api: "ollama", models: [] },
          },
        },
      };
      await state.writeConfig(cfg);
      const cases: {
        label: string;
        profileIds: string[];
        selected?: string;
      }[] = [
        { label: "none", profileIds: [] },
        {
          label: "single",
          profileIds: ["ollama-cloud:work"],
          selected: "ollama-cloud:work",
        },
        {
          label: "default",
          profileIds: ["ollama-cloud:work", "ollama-cloud:default"],
          selected: "ollama-cloud:default",
        },
        {
          label: "ambiguous",
          profileIds: ["ollama-cloud:work", "ollama-cloud:personal"],
        },
      ];
      const database = openOpenClawStateDatabase();
      const owner = acquireGatewayStateOwner({ databasePath: database.path });
      const maintenance = createOpenClawDatabaseMaintenanceScope({
        schemaMaintenance: true,
        assertOwnerCurrent: owner.assertCurrent,
        assertDatabaseAccess: owner.assertDatabaseAccess,
      });
      try {
        await maintenance.run(async () => {
          for (const row of cases) {
            await state.writeAuthProfiles({
              version: 1,
              profiles: Object.fromEntries(
                ["ollama:legacy", ...row.profileIds].map((id) => [
                  id,
                  {
                    type: "api_key",
                    provider: id === "ollama:legacy" ? "ollama" : "ollama-cloud",
                    key: `synthetic-${row.label}`,
                  },
                ]),
              ),
            });
            const authBefore = loadPersistedAuthProfileStore(state.agentDir());
            const plans: ProviderRename[] = [
              {
                ...renames[0]!,
                targetAuthProfileIds: row.profileIds,
                targetAuthProfileId: row.selected,
              },
            ];
            const suffix = row.selected ? `@${row.selected}` : "";
            const oldPrimary = "ollama/primary@ollama:legacy";
            const oldFallback = "ollama/fallback@unrelated:account";
            const newPrimary = `ollama-cloud/primary${suffix}`;
            const newFallback = `ollama-cloud/fallback${suffix}`;
            const storePath = state.statePath("cron", "jobs.json");
            await saveCronJobsStore(storePath, {
              version: 1,
              jobs: [
                makeCronJob({
                  id: row.label,
                  payload: {
                    kind: "agentTurn",
                    message: "Keep authored text",
                    model: oldPrimary,
                    fallbacks: [oldFallback, "custom/keep@custom:account"],
                  },
                }),
              ],
            });
            const scope = {
              storePath: path.join(state.sessionsDir(), "sessions.json"),
              sessionKey: "agent:main:suffix",
              env: state.env,
            };
            await replaceSessionEntry(scope, {
              sessionId: row.label,
              updatedAt: 1,
              modelProvider: "ollama",
              model: "primary@ollama:legacy",
              providerOverride: "ollama",
              modelOverride: oldFallback,
              authProfileOverride: "ollama:legacy",
              authProfileOverrideSource: "user",
              agentRuntimeOverride: "openclaw",
            });
            const before = loadSessionEntry(scope);
            const cronPreview = await maybeRepairProviderRenameCronJobs({
              cfg,
              renames: plans,
              env: state.env,
              shouldRepair: false,
            });
            const sessionPreview = await maybeRepairCodexSessionRoutes({
              cfg,
              providerRenames: plans,
              env: state.env,
              shouldRepair: false,
            });
            for (const summary of [cronPreview, sessionPreview]) {
              expect(summary.changes).toEqual([]);
              const preview = summary.warnings.join("\n");
              expect(preview).toContain("Would upgrade");
              expect(preview).toContain(oldPrimary);
              expect(preview).toContain(newPrimary);
              expect(preview).toContain(oldFallback);
              expect(preview).toContain(newFallback);
              expect(preview).toContain("To re-pin an account");
              expect(summary.warnings.filter((line) => line.includes(oldPrimary))).toHaveLength(1);
              expect(summary.warnings.filter((line) => line.includes(oldFallback))).toHaveLength(1);
            }
            expect(loadSessionEntry(scope)).toEqual(before);
            expect(loadPersistedAuthProfileStore(state.agentDir())).toEqual(authBefore);
            expect((await loadCronJobsStore(storePath)).jobs[0]?.payload).toMatchObject({
              model: oldPrimary,
              fallbacks: [oldFallback, "custom/keep@custom:account"],
            });
            const cronRepair = await maybeRepairProviderRenameCronJobs({
              cfg,
              renames: plans,
              env: state.env,
              shouldRepair: true,
            });
            const sessionRepair = await maybeRepairCodexSessionRoutes({
              cfg,
              providerRenames: plans,
              env: state.env,
              shouldRepair: true,
            });
            for (const summary of [cronRepair, sessionRepair]) {
              expect(summary.warnings).toEqual([]);
              const changes = summary.changes.join("\n");
              expect(changes).toContain(oldPrimary);
              expect(changes).toContain(newPrimary);
              expect(changes).toContain(oldFallback);
              expect(changes).toContain(newFallback);
              expect(changes).toContain("To re-pin an account");
              expect(changes).not.toContain("Would upgrade");
              expect(summary.changes.filter((line) => line.includes(oldPrimary))).toHaveLength(1);
              expect(summary.changes.filter((line) => line.includes(oldFallback))).toHaveLength(1);
            }
            expect(loadSessionEntry(scope)).toEqual({
              ...before,
              updatedAt: expect.any(Number),
              modelProvider: "ollama-cloud",
              model: `primary${suffix}`,
              providerOverride: "ollama-cloud",
              modelOverride: newFallback,
            });
            expect((await loadCronJobsStore(storePath)).jobs[0]?.payload).toMatchObject({
              model: newPrimary,
              fallbacks: [newFallback, "custom/keep@custom:account"],
            });
            expect(
              (
                await maybeRepairProviderRenameCronJobs({
                  cfg,
                  renames: plans,
                  env: state.env,
                  shouldRepair: true,
                })
              ).changes,
            ).toEqual([]);
            expect(
              (
                await maybeRepairCodexSessionRoutes({
                  cfg,
                  providerRenames: plans,
                  env: state.env,
                  shouldRepair: true,
                })
              ).changes,
            ).toEqual([]);
            expect(loadPersistedAuthProfileStore(state.agentDir())).toEqual(authBefore);
          }
        });
      } finally {
        await maintenance.close();
        owner.release();
      }
    });
  });
});
