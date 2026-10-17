import fs from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { getRegistryWorktree } from "../agents/worktrees/registry.test-support.js";
import { ManagedWorktreeService } from "../agents/worktrees/service.js";
import {
  materializeManagedWorktreeFixture,
  useManagedWorktreeTestRepository,
} from "../agents/worktrees/service.test-support.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import {
  appendTranscriptMessage,
  loadExactSessionEntryReadOnly,
  loadTranscriptEventsSync,
  replaceSessionEntry,
} from "../config/sessions/session-accessor.js";
import { resolveInitialDoctorHealthContributions } from "../flows/doctor-health-contributions-initial.js";
import {
  createDoctorHealthFlowContext,
  runDoctorHealthContributionList,
} from "../flows/doctor-health-contributions.test-support.js";
import * as sessionWorktreeLifecycle from "../sessions/session-worktree-lifecycle.js";
import { createOpenClawDatabaseMaintenanceScope } from "../state/openclaw-state-db-async-lifecycle.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";

const note = vi.hoisted(() => vi.fn());
vi.mock("../../packages/terminal-core/src/note.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../packages/terminal-core/src/note.js")>()),
  note,
}));

import { beginDoctorMaintenance } from "./doctor-maintenance.js";
import {
  detectArchivedNativeCommandSources,
  repairArchivedNativeCommandSources,
} from "./doctor-native-command-archives.js";

const initializeRepository = useManagedWorktreeTestRepository();

function nativeArchiveContribution() {
  const noop = async () => {};
  return resolveInitialDoctorHealthContributions({
    runStructuredHealthRepairs: noop,
    runGatewayConfigHealth: noop,
    runAuthProfileMigration: noop,
    runAuthProfileHealth: noop,
    runGatewayAuthHealth: noop,
    runLegacyStateHealth: noop,
  }).find((candidate) => candidate.id === "doctor:native-command-archives")!;
}

async function withSyntheticMaintenance<T>(run: () => Promise<T>): Promise<T> {
  const maintenance = createOpenClawDatabaseMaintenanceScope({
    schemaMaintenance: true,
    assertOwnerCurrent: () => {},
    assertDatabaseAccess: () => {},
  });
  try {
    return await maintenance.run(run);
  } finally {
    await maintenance.close();
  }
}

it("warns about archived native sources without changing manual archives or ordinary conversations", async () => {
  await withOpenClawTestState(
    { scenario: "minimal", label: "doctor-native-archives" },
    async (state) => {
      note.mockClear();
      const cfg = { agents: { entries: { main: {} } } };
      setRuntimeConfigSnapshot(cfg);
      const entries = [
        ["agent:main:discord:slash:user-1", { archivedAt: 10, archiveReason: "manual" }],
        ["agent:main:slack:slash:user-2", { archivedAt: 11 }],
        ["agent:main:discord:slash:user-3", {}],
        ["agent:main:discord:channel:room-1", { archivedAt: 12 }],
        ["agent:main:discord:slash:user-4", { archivedAt: 13, pluginOwnerId: "owner" }],
        [
          "agent:main:discord:slash:user-5",
          { archivedAt: 14, archiveReason: "active-session-cap" },
        ],
        ["agent:main:discord:slash:user-6", { archivedAt: 15, archiveReason: "age-retention" }],
      ] as const;
      for (const [sessionKey, fields] of entries) {
        await replaceSessionEntry(
          { agentId: "main", sessionKey, env: state.env },
          {
            sessionId: sessionKey,
            updatedAt: 1,
            ...fields,
          },
        );
      }

      const findings = detectArchivedNativeCommandSources({ cfg, env: state.env });
      expect(findings.map(({ target: _target, ...finding }) => finding)).toEqual([
        {
          key: "agent:main:discord:slash:user-1",
          sessionId: "agent:main:discord:slash:user-1",
          reason: "manual",
        },
        {
          key: "agent:main:discord:slash:user-5",
          sessionId: "agent:main:discord:slash:user-5",
          reason: "active-session-cap",
        },
        {
          key: "agent:main:discord:slash:user-6",
          sessionId: "agent:main:discord:slash:user-6",
          reason: "age-retention",
        },
        {
          key: "agent:main:slack:slash:user-2",
          sessionId: "agent:main:slack:slash:user-2",
          reason: "unknown",
        },
      ]);
      await nativeArchiveContribution().run(
        createDoctorHealthFlowContext({
          cfg,
          env: state.env,
          options: { yes: true },
        }),
      );
      expect(note).toHaveBeenCalledWith(
        expect.stringContaining("Control UI → Sessions → Archived"),
        "Archived native commands",
      );
      for (const [sessionKey, fields] of entries) {
        expect(
          loadExactSessionEntryReadOnly({ agentId: "main", sessionKey, env: state.env })?.entry,
        ).toMatchObject({
          sessionId: sessionKey,
          ...fields,
        });
      }
    },
  );
});

it("requires real Doctor custody and restores only exact internal sources without rotating identity", async () => {
  await withOpenClawTestState(
    { scenario: "external-service", label: "doctor-native-archives-repair" },
    async (state) => {
      note.mockClear();
      const cfg = { agents: { entries: { main: {} } } };
      await state.writeConfig(cfg);
      setRuntimeConfigSnapshot(cfg);
      const params = { cfg, env: state.env };
      await expect(repairArchivedNativeCommandSources(params)).rejects.toThrow(
        "requires Doctor maintenance ownership",
      );
      const maintenance = await beginDoctorMaintenance({
        root: null,
        options: { repair: true, nonInteractive: true },
        runtime: {
          log: () => {},
          error: () => {},
          exit: (code) => {
            throw new Error(`Unexpected exit ${code}`);
          },
        },
      });
      if (!maintenance) {
        throw new Error("Expected standalone Doctor maintenance");
      }
      try {
        await maintenance.run(async () => {
          const entries = [
            ["agent:main:discord:slash:user-1", { archivedAt: 10, archiveReason: "manual" }],
            ["agent:main:slack:slash:user-2", { archivedAt: 11, archiveReason: "age-retention" }],
            ["agent:main:discord:channel:room-1", { archivedAt: 12 }],
            ["agent:main:discord:slash:user-3", { archivedAt: 13, pluginOwnerId: "owner" }],
            ["agent:main:discord:slash:user-4", {}],
            [
              "agent:main:discord:slash:user-5",
              {
                archivedAt: 14,
                worktree: { id: "missing", branch: "fixture", repoRoot: "/missing-repo" },
              },
            ],
          ] as const;
          for (const [sessionKey, fields] of entries) {
            await replaceSessionEntry(
              { agentId: "main", sessionKey, env: state.env },
              { sessionId: `id:${sessionKey}`, updatedAt: 7, ...fields },
            );
          }
          const before = new Map(
            entries.map(
              ([sessionKey]) =>
                [
                  sessionKey,
                  loadExactSessionEntryReadOnly({ agentId: "main", sessionKey, env: state.env })
                    ?.entry,
                ] as const,
            ),
          );
          await expect(
            repairArchivedNativeCommandSources({
              cfg,
              env: { ...state.env, OPENCLAW_STATE_DIR: state.path("foreign-state") },
            }),
          ).rejects.toThrow("does not own this database");
          await nativeArchiveContribution().run(
            createDoctorHealthFlowContext({
              cfg,
              env: state.env,
              options: { repair: true },
            }),
          );
          expect(note).toHaveBeenCalledWith(
            expect.stringContaining(
              "Found 3 archived native-command source session(s); restored 2, skipped 1",
            ),
            "Archived native commands",
          );
          for (const [sessionKey, fields] of entries) {
            const expected = { ...before.get(sessionKey) };
            if (
              sessionKey.includes(":slash:") &&
              !("pluginOwnerId" in fields) &&
              !("worktree" in fields)
            ) {
              delete expected.archivedAt;
              delete expected.archivedBy;
              delete expected.archiveReason;
            }
            expect(
              loadExactSessionEntryReadOnly({ agentId: "main", sessionKey, env: state.env })?.entry,
            ).toEqual(expected);
          }
        });
      } finally {
        await maintenance.release();
      }
    },
  );
});

it.each(["absent", "different identity", "same identity"])(
  "repairs the scanned custom store when the default store has %s for the same key",
  async (defaultSource) => {
    await withOpenClawTestState(
      { scenario: "minimal", label: "doctor-native-archives-two-stores" },
      async (state) => {
        const storePath = state.path("custom", "sessions.json");
        const cfg = { agents: { entries: { main: {} } }, session: { store: storePath } };
        setRuntimeConfigSnapshot(cfg);
        const sessionKey = "agent:main:discord:slash:two-store-user";
        const defaultScope = {
          agentId: "main",
          sessionKey,
          storePath: state.statePath("agents", "main", "sessions", "sessions.json"),
          env: state.env,
        };
        const customScope = { ...defaultScope, storePath };
        const ordinaryScope = {
          ...defaultScope,
          sessionKey: "agent:main:discord:channel:retained-archive",
        };
        const ordinaryEntry = {
          sessionId: "ordinary",
          updatedAt: 5,
          archivedAt: 9,
          delivery: { kind: "none" as const },
        };
        await replaceSessionEntry(ordinaryScope, ordinaryEntry);
        const customEntry = {
          sessionId: "custom-source",
          updatedAt: 7,
          label: "Custom store",
          delivery: { kind: "none" as const },
        };
        await replaceSessionEntry(customScope, {
          ...customEntry,
          archivedAt: 10,
          archiveReason: "manual",
        });
        const defaultEntry = {
          sessionId: defaultSource === "same identity" ? "custom-source" : "default-source",
          updatedAt: 8,
          label: "Default store",
          delivery: { kind: "none" as const },
        };
        if (defaultSource !== "absent") {
          await replaceSessionEntry(defaultScope, {
            ...defaultEntry,
            archivedAt: 11,
            archiveReason: "age-retention",
          });
        }
        const expectedCount = defaultSource === "absent" ? 1 : 2;
        await expect(
          withSyntheticMaintenance(() =>
            repairArchivedNativeCommandSources({ cfg, env: state.env }),
          ),
        ).resolves.toEqual({ found: expectedCount, repaired: expectedCount, skipped: 0 });
        expect(loadExactSessionEntryReadOnly(customScope)?.entry).toEqual(customEntry);
        expect(loadExactSessionEntryReadOnly(defaultScope)?.entry).toEqual(
          defaultSource === "absent" ? undefined : defaultEntry,
        );
        expect(loadExactSessionEntryReadOnly(ordinaryScope)?.entry).toEqual(ordinaryEntry);
      },
    );
  },
);

it("omits native archive repair during updater Doctor but restores it in standalone Doctor", async () => {
  await withOpenClawTestState(
    { scenario: "minimal", label: "doctor-native-archives-updater" },
    async (state) => {
      note.mockClear();
      const cfg = { agents: { entries: { main: {} } } };
      setRuntimeConfigSnapshot(cfg);
      const sessionKey = "agent:main:discord:slash:updater-user";
      const scope = { agentId: "main", sessionKey, env: state.env };
      await replaceSessionEntry(scope, {
        sessionId: "updater-source",
        updatedAt: 7,
        archivedAt: 10,
        archiveReason: "manual",
      });
      await withSyntheticMaintenance(async () => {
        await runDoctorHealthContributionList(
          createDoctorHealthFlowContext({
            cfg,
            env: { ...state.env, OPENCLAW_UPDATE_IN_PROGRESS: "1" },
            options: { repair: true },
          }),
          [nativeArchiveContribution()],
        );
        expect(loadExactSessionEntryReadOnly(scope)?.entry.archivedAt).toBe(10);
        expect(note).toHaveBeenCalledWith(
          expect.stringContaining("Omitted during update: Native command archives"),
          "Update Doctor scope",
        );
        await runDoctorHealthContributionList(
          createDoctorHealthFlowContext({ cfg, env: state.env, options: { repair: true } }),
          [nativeArchiveContribution()],
        );
        expect(loadExactSessionEntryReadOnly(scope)?.entry).toMatchObject({
          sessionId: "updater-source",
          updatedAt: 7,
        });
        expect(loadExactSessionEntryReadOnly(scope)?.entry.archivedAt).toBeUndefined();
      });
    },
  );
});

it("restores a managed archived worktree while preserving the transcript and session identity", async () => {
  await withOpenClawTestState(
    { scenario: "minimal", label: "doctor-native-archives-worktree" },
    async (state) => {
      const cfg = { agents: { entries: { main: {} } } };
      setRuntimeConfigSnapshot(cfg);
      const sessionKey = "agent:main:discord:slash:worktree-user";
      const sessionId = "archived-native-worktree";
      const scope = { agentId: "main", sessionKey, env: state.env };
      const repoRoot = await initializeRepository(state.path("worktree-fixture"));
      const record = await materializeManagedWorktreeFixture({
        env: state.env,
        stateDir: state.stateDir,
        repoRoot,
        name: "native-archive",
        now: 1,
        ownerKind: "session",
        ownerId: sessionKey,
      });
      await fs.writeFile(path.join(record.path, "draft.txt"), "retained worktree draft\n");
      await new ManagedWorktreeService({ env: state.env, now: () => 2 }).remove({
        id: record.id,
        reason: "archive fixture",
      });
      expect(getRegistryWorktree(state.env, record.id)?.removedAt).toBe(2);
      await replaceSessionEntry(scope, {
        sessionId,
        updatedAt: 7,
        worktree: { id: record.id, branch: record.branch, repoRoot },
      });
      const transcriptScope = { ...scope, sessionId };
      await appendTranscriptMessage(transcriptScope, {
        eventId: "retained-user-event",
        message: { role: "user", content: "retained history", timestamp: 1 },
      });
      const transcriptBefore = loadTranscriptEventsSync(transcriptScope);
      expect(transcriptBefore).toHaveLength(2);
      expect(transcriptBefore.at(-1)).toMatchObject({
        type: "message",
        id: "retained-user-event",
        message: { role: "user", content: "retained history" },
      });
      await replaceSessionEntry(scope, {
        sessionId,
        updatedAt: 7,
        archivedAt: 10,
        archiveReason: "manual",
        worktree: { id: record.id, branch: record.branch, repoRoot },
      });
      const before = loadExactSessionEntryReadOnly(scope)?.entry;
      await withSyntheticMaintenance(() =>
        repairArchivedNativeCommandSources({ cfg, env: state.env }),
      );
      const after = loadExactSessionEntryReadOnly(scope)?.entry;
      const expected = { ...before };
      delete expected.archivedAt;
      delete expected.archiveReason;
      expect(after).toEqual(expected);
      expect(loadTranscriptEventsSync(transcriptScope)).toEqual(transcriptBefore);
      expect(await fs.readFile(path.join(record.path, "draft.txt"), "utf8")).toBe(
        "retained worktree draft\n",
      );
      expect(getRegistryWorktree(state.env, record.id)?.removedAt).toBeUndefined();
    },
  );
});

it("leaves a source archived when its lifecycle revision changes after the scan", async () => {
  await withOpenClawTestState(
    { scenario: "minimal", label: "doctor-native-archives-stale" },
    async (state) => {
      const cfg = { agents: { entries: { main: {} } } };
      setRuntimeConfigSnapshot(cfg);
      const sessionKey = "agent:main:discord:slash:stale-user";
      const scope = { agentId: "main", sessionKey, env: state.env };
      await replaceSessionEntry(scope, {
        sessionId: "stale-source",
        updatedAt: 7,
        archivedAt: 10,
        lifecycleRevision: "revision-1",
      });
      const restore = vi
        .spyOn(sessionWorktreeLifecycle, "restoreSessionWorktree")
        .mockImplementationOnce(async () => {
          await replaceSessionEntry(scope, {
            sessionId: "stale-source",
            updatedAt: 7,
            archivedAt: 10,
            lifecycleRevision: "revision-2",
          });
          return () => {};
        });
      try {
        await expect(
          withSyntheticMaintenance(() =>
            repairArchivedNativeCommandSources({ cfg, env: state.env }),
          ),
        ).resolves.toEqual({ found: 1, repaired: 0, skipped: 1 });
        expect(restore).toHaveBeenCalledOnce();
      } finally {
        restore.mockRestore();
      }
      expect(loadExactSessionEntryReadOnly(scope)?.entry).toMatchObject({
        sessionId: "stale-source",
        archivedAt: 10,
        lifecycleRevision: "revision-2",
      });
    },
  );
});
