import { vi } from "vitest";
import type { RunEmbeddedAgentParams } from "../agents/embedded-agent-runner/run/params.js";
import type { SessionEntry } from "../config/sessions/types.js";

let testTempDir: string | undefined;

export function setAgentConsultTestTempDir(tempDir: string | undefined): void {
  testTempDir = tempDir;
}

export function testTempPath(name: string): string {
  if (!testTempDir) {
    throw new Error("Expected an isolated consult runtime test directory");
  }
  return `${testTempDir}/${name}`;
}

export function createAgentRuntime(payloads: unknown[] = [{ text: "Speak this." }]) {
  const sessionStore: Record<
    string,
    {
      sessionId?: string;
      updatedAt?: number;
      createdVia?: SessionEntry["createdVia"];
      createdActor?: SessionEntry["createdActor"];
      createdAt?: number;
      sandbox?: SessionEntry["sandbox"];
      archivedAt?: number;
      sessionFile?: string;
      spawnedBy?: string;
      agentHarnessId?: string;
      modelSelectionLocked?: boolean;
      forkedFromParent?: boolean;
      totalTokens?: number;
      delivery?: SessionEntry["delivery"];
      permissionMode?: SessionEntry["permissionMode"];
      toolOverrides?: SessionEntry["toolOverrides"];
    }
  > = {};
  const runEmbeddedAgent = vi.fn(async (_params?: RunEmbeddedAgentParams) => ({
    payloads,
    meta: {},
  }));
  const updateSessionStore = vi.fn(
    async (
      _storePath: string,
      mutator: (store: Record<string, { sessionId?: string; updatedAt?: number }>) => unknown,
    ) => await mutator(sessionStore),
  );
  const getSessionEntry = vi.fn(
    (params: { sessionKey: string }) => sessionStore[params.sessionKey],
  );
  const patchSessionEntry = vi.fn(
    async (params: {
      sessionKey: string;
      fallbackEntry?: Record<string, unknown>;
      update: (
        entry: Record<string, unknown>,
      ) => Promise<Record<string, unknown> | null> | Record<string, unknown> | null;
    }) => {
      const existing = sessionStore[params.sessionKey] ?? params.fallbackEntry;
      if (!existing) {
        return null;
      }
      const patch = await params.update({ ...existing });
      if (!patch) {
        return existing;
      }
      const next = { ...existing, ...patch };
      sessionStore[params.sessionKey] = next;
      return next;
    },
  );
  const upsertSessionEntry = vi.fn(
    async (params: { sessionKey: string; entry: Record<string, unknown> }) => {
      sessionStore[params.sessionKey] = { ...params.entry };
    },
  );
  return {
    runtime: {
      resolveAgentDir: vi.fn(() => testTempPath("agent")),
      resolveAgentWorkspaceDir: vi.fn(() => testTempPath("workspace")),
      ensureAgentWorkspace: vi.fn(async () => {}),
      resolveAgentTimeoutMs: vi.fn(() => 30_000),
      session: {
        resolveStorePath: vi.fn(() => testTempPath("sessions.json")),
        loadSessionStore: vi.fn(() => sessionStore),
        saveSessionStore: vi.fn(async () => {}),
        updateSessionStore,
        getSessionEntry,
        patchSessionEntry,
        upsertSessionEntry,
        resolveSessionFilePath: vi.fn(
          (_sessionId: string, entry?: { sessionFile?: string }) =>
            entry?.sessionFile ?? testTempPath("session.json"),
        ),
      },
      runEmbeddedAgent,
    },
    runEmbeddedAgent,
    sessionStore,
  };
}
