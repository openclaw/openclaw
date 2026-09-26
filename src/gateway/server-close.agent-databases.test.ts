import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { collectNestedErrorCandidates } from "@openclaw/normalization-core/error-coercion";
import { expect, it, vi } from "vitest";
import { loadSessionEntry, replaceSessionEntry } from "../config/sessions/session-accessor.js";
import { PluginInstance } from "../plugins/plugin-instance.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { createPluginRecord } from "../plugins/status.test-helpers.js";
import { getActiveSecretsRuntimeSnapshotState } from "../secrets/runtime-state.js";
import { createDeferredCore } from "../shared/deferred.js";
import { isPidAlive } from "../shared/pid-alive.js";
import {
  beginAgentDeletionJournal,
  completeAgentDeletionJournalInDatabase,
} from "../state/agent-deletion-journal.js";
import {
  assertNoOpenClawAgentDatabaseLeasesReadOnly,
  OpenClawAgentDatabaseLeaseActiveError,
} from "../state/openclaw-agent-db-lease.js";
import { registerOpenClawAgentDatabaseAsyncResource } from "../state/openclaw-agent-db-resources.js";
import {
  listOpenIncognitoAgentDatabases,
  openOpenClawAgentDatabase,
  resolveIncognitoOpenClawAgentSqlitePath,
} from "../state/openclaw-agent-db.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import { createGatewayMetadataCloseFixture } from "./server-close.metadata.test-support.js";

it("closes a Gateway with an active plugin while retaining a deleted agent store", async () => {
  const fixture = await createGatewayMetadataCloseFixture("gateway-retained-deleted-agent-close");
  try {
    const pluginId = fixture.pluginId;
    const registry = createEmptyPluginRegistry();
    const record = createPluginRecord({ id: pluginId });
    const registered = new PluginInstance(record.id, { record, registry });
    let disposed = false;
    registered.lifecycle.onDispose(() => {
      disposed = true;
    });
    registry.plugins.push(record);
    setActivePluginRegistry(registry);
    const port = await fixture.reservePort();
    const server = await fixture.start(port);
    expect(fixture.kernels.get(port)?.pluginRuntime.registry.plugins).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: pluginId })]),
    );
    const activeStore = path.join(fixture.state.sessionsDir("main"), "sessions.json");
    const retainedStore = path.join(fixture.state.sessionsDir("retired"), "sessions.json");
    for (const [agentId, storePath] of [
      ["main", activeStore],
      ["retired", retainedStore],
    ] as const) {
      await replaceSessionEntry(
        { agentId, storePath, sessionKey: `agent:${agentId}:main` },
        {
          sessionId: `${agentId}-session`,
          updatedAt: 1,
          pluginExtensions: { [pluginId]: { active: true } },
        },
      );
    }
    const retainedDatabase = path.join(fixture.state.agentDir("retired"), "openclaw-agent.sqlite");
    const operationId = randomUUID();
    beginAgentDeletionJournal(
      {
        agentId: "retired",
        operationId,
        agentDir: fixture.state.agentDir("retired"),
        sessionsDir: fixture.state.sessionsDir("retired"),
        workspaceDir: path.join(fixture.state.root, "workspace-retired"),
        databasePaths: [retainedDatabase],
        deleteFiles: false,
      },
      { env: fixture.state.env },
    );
    runOpenClawStateWriteTransaction(
      (database) => completeAgentDeletionJournalInDatabase(database, "retired", operationId),
      { env: fixture.state.env },
    );
    await expect(server.close({ reason: "gateway stopping" })).resolves.toBeUndefined();
    expect(disposed).toBe(true);
    expect((await fs.stat(retainedDatabase)).isFile()).toBe(true);
    expect(
      loadSessionEntry({ agentId: "main", storePath: activeStore, sessionKey: "agent:main:main" })
        ?.pluginExtensions,
    ).toBeUndefined();
  } finally {
    await fixture.cleanup();
  }
}, 300_000);

it.each(["stop", "restart"] as const)(
  "releases agent leases for Doctor after the final Gateway %s while its process stays alive",
  async (mode) => {
    const fixture = await createGatewayMetadataCloseFixture(`gateway-agent-leases-${mode}`);
    const ownerPid = process.pid;
    try {
      const first = await fixture.start(await fixture.reservePort());
      const siblingPort = await fixture.reservePort();
      const sibling = await fixture.start(siblingPort);
      const options = { agentId: "main", env: fixture.state.env };
      const agent = openOpenClawAgentDatabase(options);
      const incognito = openOpenClawAgentDatabase({
        ...options,
        path: resolveIncognitoOpenClawAgentSqlitePath(options),
      });
      const shared = openOpenClawStateDatabase({ env: fixture.state.env }).db;
      const inspectForDoctor = () =>
        assertNoOpenClawAgentDatabaseLeasesReadOnly({ env: fixture.state.env });
      expect(inspectForDoctor).toThrow(OpenClawAgentDatabaseLeaseActiveError);
      const closeOptions = {
        reason: mode === "restart" ? "gateway restarting" : "gateway stopping",
        restartExpectedMs: mode === "restart" ? 1_500 : null,
      };

      await first.close(closeOptions);
      expect(agent.db.isOpen).toBe(true);
      expect(incognito.db.isOpen).toBe(true);
      expect(inspectForDoctor).toThrow(OpenClawAgentDatabaseLeaseActiveError);
      const response = await fetch(`http://127.0.0.1:${siblingPort}/healthz`);
      await response.body?.cancel();
      expect(response.ok).toBe(true);

      await sibling.close(closeOptions);
      expect(process.pid).toBe(ownerPid);
      expect(isPidAlive(ownerPid)).toBe(true);
      expect(inspectForDoctor).not.toThrow();
      expect(agent.db.isOpen).toBe(false);
      expect(shared.isOpen).toBe(false);
      expect(incognito.db.isOpen).toBe(false);
      expect(listOpenIncognitoAgentDatabases()).not.toContainEqual({
        agentId: "main",
        storePath: incognito.path,
      });
    } finally {
      await fixture.cleanup();
    }
  },
);

it("joins admitted agent database resources before releasing their lease and shared state", async () => {
  const fixture = await createGatewayMetadataCloseFixture("gateway-agent-resource-close");
  const entered = createDeferredCore();
  const release = createDeferredCore();
  let closing: Promise<void> | undefined;
  let unregister: (() => void) | undefined;
  try {
    const server = await fixture.start(await fixture.reservePort());
    const agent = openOpenClawAgentDatabase({ agentId: "main", env: fixture.state.env });
    const shared = openOpenClawStateDatabase({ env: fixture.state.env }).db;
    unregister = registerOpenClawAgentDatabaseAsyncResource({
      agentId: "main",
      path: agent.path,
      revoke() {},
      async close() {
        entered.resolve();
        await release.promise;
      },
    });
    closing = server.close({ reason: "gateway restarting", restartExpectedMs: 1_500 });
    await Promise.race([
      entered.promise,
      closing.then(() => {
        throw new Error("Gateway acknowledged closure before its agent resource joined");
      }),
    ]);
    expect(agent.db.isOpen).toBe(true);
    expect(shared.isOpen).toBe(true);
    expect(() => assertNoOpenClawAgentDatabaseLeasesReadOnly({ env: fixture.state.env })).toThrow(
      OpenClawAgentDatabaseLeaseActiveError,
    );
    release.resolve();
    await closing;
    expect(agent.db.isOpen).toBe(false);
    expect(shared.isOpen).toBe(false);
    expect(() =>
      assertNoOpenClawAgentDatabaseLeasesReadOnly({ env: fixture.state.env }),
    ).not.toThrow();
  } finally {
    release.resolve();
    await Promise.allSettled([closing]);
    unregister?.();
    await fixture.cleanup();
  }
});

it("rejects Gateway closure when an agent handle cannot close and retains its lease", async () => {
  const fixture = await createGatewayMetadataCloseFixture("gateway-agent-close-failure");
  let restoreClose: (() => void) | undefined;
  try {
    const server = await fixture.start(await fixture.reservePort());
    const agent = openOpenClawAgentDatabase({ agentId: "main", env: fixture.state.env });
    const shared = openOpenClawStateDatabase({ env: fixture.state.env }).db;
    const failure = new Error("native agent database close failed");
    const blockedClose = vi.spyOn(agent.db, "close").mockImplementation(() => {
      throw failure;
    });
    restoreClose = () => blockedClose.mockRestore();

    const outcome = await server
      .close({ reason: "gateway restarting", restartExpectedMs: 1_500 })
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    expect(collectNestedErrorCandidates(outcome)).toContain(failure);
    expect(agent.db.isOpen).toBe(true);
    expect(shared.isOpen).toBe(true);
    expect(getActiveSecretsRuntimeSnapshotState()).not.toBeNull();
    expect(() => assertNoOpenClawAgentDatabaseLeasesReadOnly({ env: fixture.state.env })).toThrow(
      OpenClawAgentDatabaseLeaseActiveError,
    );
  } finally {
    restoreClose?.();
    await fixture.cleanup();
  }
});
