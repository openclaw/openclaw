import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  readPersistedAuthProfileStateRaw,
  readPersistedAuthProfileStoreRaw,
  readPersistedSharedAuthProfileStoreRaw,
  runAuthProfileWriteTransaction,
  writePersistedAuthProfileStateRaw,
  writePersistedAuthProfileStoreRaw,
} from "../../agents/auth-profiles/sqlite.js";
import { loadSessionEntry, replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  collectOpenAICodexAuthProfileStoreIdMap,
  maybeRepairLegacyAuthProfileStores,
} from "../doctor-auth-flat-profiles.js";
import { runDoctorRepairSequence } from "./repair-sequencing.js";
import { maybeRepairCodexSessionRoutes } from "./shared/codex-route-session-repair.js";

describe("Doctor auth alias preservation", () => {
  it.each([false, true])(
    "recovers a failed config write without adopting a changed account (%s)",
    async (replaceAccount) => {
      await withOpenClawTestState(
        { label: "alias-config-recovery", layout: "home" },
        async (fixture) => {
          const agentDir = fixture.agentDir("worker");
          const cfg: OpenClawConfig = {
            plugins: { enabled: false },
            agents: { entries: { main: {}, worker: { agentDir } } },
            auth: {
              profiles: { "openai-codex:work": { provider: "openai-codex", mode: "api_key" } },
              order: { "openai-codex": ["openai-codex:work"] },
            },
          };
          runAuthProfileWriteTransaction(
            undefined,
            (database) => {
              writePersistedAuthProfileStoreRaw(
                {
                  version: 1,
                  profiles: {
                    "openai-codex:work": {
                      type: "api_key",
                      provider: "openai-codex",
                      key: "synthetic-original-account",
                    },
                  },
                },
                undefined,
                database,
              );
            },
            { env: fixture.env },
          );
          const workerStore = {
            version: 1,
            profiles: {
              "openai-codex:work": {
                type: "api_key",
                provider: "openai-codex",
                key: "synthetic-worker-account",
              },
            },
          };
          runAuthProfileWriteTransaction(
            agentDir,
            (database) => {
              writePersistedAuthProfileStoreRaw(workerStore, agentDir, database);
            },
            { env: fixture.env },
          );
          const run = () =>
            runDoctorRepairSequence({
              state: { cfg, candidate: structuredClone(cfg), pendingChanges: false, fixHints: [] },
              doctorFixCommand: "openclaw doctor --fix",
              env: fixture.env,
            });
          // The durable store commit survives even when the caller cannot save this candidate.
          await run();
          expect(readPersistedSharedAuthProfileStoreRaw(fixture.env)).toMatchObject({
            profiles: { "openai:work": { provider: "openai", key: "synthetic-original-account" } },
          });
          if (replaceAccount) {
            runAuthProfileWriteTransaction(
              undefined,
              (database) => {
                writePersistedAuthProfileStoreRaw(
                  {
                    version: 1,
                    profiles: {
                      "openai:work": {
                        type: "api_key",
                        provider: "openai",
                        key: "synthetic-replacement-account",
                      },
                    },
                  },
                  undefined,
                  database,
                );
              },
              { env: fixture.env },
            );
          } else {
            // A stopped multi-store pass can leave one owner at its recorded pre-migration state.
            runAuthProfileWriteTransaction(
              agentDir,
              (database) => {
                writePersistedAuthProfileStoreRaw(workerStore, agentDir, database);
              },
              { env: fixture.env },
            );
          }
          const resumed = await run();
          if (replaceAccount) {
            expect(resumed.state.candidate.auth).toEqual(cfg.auth);
            expect(readPersistedSharedAuthProfileStoreRaw(fixture.env)).toMatchObject({
              profiles: { "openai:work": { key: "synthetic-replacement-account" } },
            });
          } else {
            expect(resumed.state.candidate.auth).toEqual({
              profiles: { "openai:work": { provider: "openai", mode: "api_key" } },
              order: { openai: ["openai:work"] },
            });
            expect(resumed.openAICodexAuthProfileIdMap?.get("openai-codex:work")).toBe(
              "openai:work",
            );
            expect(readPersistedAuthProfileStoreRaw(agentDir)).toMatchObject({
              profiles: { "openai:work": { provider: "openai", key: "synthetic-worker-account" } },
            });
          }
        },
      );
    },
  );
  it.each([
    ["claude-cli:work", "claude-cli", "anthropic:work", "shared"],
    ["google-gemini-cli:work", "google-gemini-cli", "google:work", "agent"],
  ])(
    "keeps the selected session account when migrating %s",
    async (id, provider, canonical, owner) => {
      await withOpenClawTestState({ label: "alias-session", layout: "home" }, async (fixture) => {
        const agentDir = fixture.agentDir("worker");
        const cfg: OpenClawConfig = {
          plugins: { enabled: false },
          agents: { entries: { main: {}, worker: { agentDir } } },
          auth: { profiles: { [id]: { provider, mode: "api_key" } } },
        };
        runAuthProfileWriteTransaction(
          owner === "shared" ? undefined : agentDir,
          (database) => {
            writePersistedAuthProfileStoreRaw(
              {
                version: 1,
                profiles: { [id]: { type: "api_key", provider, key: "synthetic-session-key" } },
              },
              owner === "shared" ? undefined : agentDir,
              database,
            );
          },
          { env: fixture.env },
        );
        const storePath = path.join(fixture.stateDir, "agents/worker/sessions/sessions.json");
        const sessionKey = "agent:worker:main";
        await replaceSessionEntry(
          { storePath, sessionKey, env: fixture.env },
          {
            sessionId: "selected-account",
            updatedAt: 1234,
            authProfileOverride: id,
            authProfileOverrideSource: "user",
          },
        );
        const repaired = await runDoctorRepairSequence({
          state: { cfg, candidate: structuredClone(cfg), pendingChanges: false, fixHints: [] },
          doctorFixCommand: "openclaw doctor --fix",
          env: fixture.env,
        });
        await maybeRepairCodexSessionRoutes({
          cfg: repaired.state.candidate,
          env: fixture.env,
          shouldRepair: true,
          authProfileIdMap: repaired.openAICodexAuthProfileIdMap,
        });
        expect(loadSessionEntry({ storePath, sessionKey, env: fixture.env })).toMatchObject({
          sessionId: "selected-account",
          authProfileOverride: canonical,
          authProfileOverrideSource: "user",
        });
      });
    },
  );

  it("rejects newly occupied inherited rotation state before changing any store", async () => {
    await withOpenClawTestState(
      { label: "alias-inherited-state", layout: "home" },
      async (fixture) => {
        const agentDir = fixture.agentDir("worker");
        const cfg: OpenClawConfig = { plugins: { enabled: false } };
        const shared = {
          version: 1,
          profiles: {
            "openai-codex:work": {
              type: "api_key",
              provider: "openai-codex",
              key: "synthetic-shared-key",
            },
          },
        };
        runAuthProfileWriteTransaction(
          undefined,
          (database) => {
            writePersistedAuthProfileStoreRaw(shared, undefined, database);
          },
          { env: fixture.env },
        );
        runAuthProfileWriteTransaction(
          agentDir,
          (database) => {
            writePersistedAuthProfileStateRaw(
              { version: 1, usageStats: { "openai-codex:work": { errorCount: 2 } } },
              agentDir,
              database,
            );
          },
          { env: fixture.env },
        );
        const profileIdMap = collectOpenAICodexAuthProfileStoreIdMap({ cfg, env: fixture.env });
        expect(profileIdMap.get("openai-codex:work")).toBe("openai:work");
        const currentState = {
          version: 1,
          usageStats: {
            "openai-codex:work": { errorCount: 2 },
            "openai:work": { errorCount: 99 },
          },
        };
        runAuthProfileWriteTransaction(
          agentDir,
          (database) => {
            writePersistedAuthProfileStateRaw(currentState, agentDir, database);
          },
          { env: fixture.env },
        );
        const result = maybeRepairLegacyAuthProfileStores({ cfg, env: fixture.env, profileIdMap });
        expect(result.changes).toEqual([]);
        expect(result.profileIdMap.size).toBe(0);
        expect(readPersistedSharedAuthProfileStoreRaw(fixture.env)).toEqual(shared);
        expect(readPersistedAuthProfileStateRaw(agentDir)).toEqual(currentState);
      },
    );
  });

  it("preserves a blocked custom account order while an independent account migrates", async () => {
    await withOpenClawTestState(
      { label: "alias-custom-order", layout: "home" },
      async (fixture) => {
        const blocked = {
          type: "api_key",
          provider: "claude-cli",
          key: "synthetic-realm-key",
          issuer: "https://fixture.invalid/issuer",
        };
        const cfg: OpenClawConfig = {
          plugins: { enabled: false },
          auth: {
            profiles: {
              "work-account": { provider: "claude-cli", mode: "api_key" },
              "codex:ready": { provider: "codex", mode: "api_key" },
            },
            order: { "claude-cli": ["work-account"], codex: ["codex:ready"] },
          },
        };
        runAuthProfileWriteTransaction(
          undefined,
          (database) => {
            writePersistedAuthProfileStoreRaw(
              {
                version: 1,
                profiles: {
                  "work-account": blocked,
                  "codex:ready": { type: "api_key", provider: "codex", key: "synthetic-ready-key" },
                },
                order: cfg.auth?.order,
              },
              undefined,
              database,
            );
          },
          { env: fixture.env },
        );
        const result = await runDoctorRepairSequence({
          state: { cfg, candidate: structuredClone(cfg), pendingChanges: false, fixHints: [] },
          doctorFixCommand: "openclaw doctor --fix",
          env: fixture.env,
        });
        expect(result.state.candidate.auth?.order).toEqual({
          "claude-cli": ["work-account"],
          openai: ["openai:ready"],
        });
        expect(readPersistedSharedAuthProfileStoreRaw(fixture.env)).toMatchObject({
          profiles: {
            "work-account": blocked,
            "openai:ready": { provider: "openai", key: "synthetic-ready-key" },
          },
          order: { "claude-cli": ["work-account"], openai: ["openai:ready"] },
        });
      },
    );
  });
});
