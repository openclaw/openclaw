import { afterAll, afterEach, expect, it, vi } from "vitest";
import * as runtimeOwnership from "../../agents/harness/session-runtime-ownership.js";
import { resetConfigRuntimeState, setRuntimeConfigSnapshot } from "../../config/config.js";
import { replaceSessionEntrySync } from "../../config/sessions/session-accessor.js";
import { writeSessionEntry } from "../../config/sessions/session-accessor.sqlite-entry-store.js";
import { runOpenClawAgentWriteTransaction } from "../../state/openclaw-agent-db.js";
import { useSessionStoreTempDirs } from "../../test-utils/session-state-cleanup.js";
import { getSessionRowProjection } from "../session-row-projection-access.js";
import { createSessionCatalogRequestEntrySnapshot } from "./session-catalog-entry-snapshot.js";
import {
  disposeSessionReadContexts,
  initializeSessionReadContext,
  requestContext,
} from "./sessions-read-cache.test-support.js";

const tempDirs = useSessionStoreTempDirs(afterAll, "catalog-delivery-selection-");
afterEach(async () => {
  await disposeSessionReadContexts();
  resetConfigRuntimeState();
  vi.unstubAllEnvs();
});

it("selects delivery aliases across agents without narrowing provider planning", async () => {
  vi.stubEnv("OPENCLAW_STATE_DIR", tempDirs.make());
  const cfg = { agents: { ownership: "explicit" as const, entries: { main: {}, work: {} } } };
  setRuntimeConfigSnapshot(cfg, cfg);
  for (const agentId of ["main", "work"]) {
    runOpenClawAgentWriteTransaction(
      (database) => {
        for (const name of ["main", "unused"]) {
          writeSessionEntry(database, `agent:${agentId}:${name}`, {
            sessionId: `${agentId}-${name}`,
            updatedAt: 1,
          });
        }
        if (agentId === "main") {
          writeSessionEntry(database, "global", { sessionId: "main-global", updatedAt: 1 });
        }
      },
      { agentId },
    );
  }
  const hosts = [["main", "global"], ["agent:work:main"]].map((sessionKeys, index) => ({
    hostId: `gateway:${index}`,
    label: `Host ${index}`,
    kind: "gateway" as const,
    connected: true,
    sessions: sessionKeys.map((sessionKey) => ({
      sessionKey,
      threadId: `thread-${sessionKey}`,
      status: "stored" as const,
      archived: false,
      canContinue: true,
      canArchive: false,
    })),
  }));
  const context = requestContext(cfg);
  await initializeSessionReadContext(context);
  const projection = getSessionRowProjection(context);
  if (!projection) {
    throw new Error("Session projection is unavailable after fixture initialization");
  }
  while (projection.needsMaterialization) {
    await projection.ensureMaterialized();
  }
  using ownership = vi.spyOn(runtimeOwnership, "readSessionRuntimeOwnershipAsync");
  ownership.mockRejectedValue(
    new Error("Runtime ownership is unavailable during catalog enumeration"),
  );
  replaceSessionEntrySync(
    { agentId: "main", sessionKey: "agent:main:main" },
    { sessionId: "main-main", updatedAt: 2 },
  );
  await projection.prepareSelection({ metadataOnly: true });
  const planning = createSessionCatalogRequestEntrySnapshot({
    cfg,
    fallbackAgentId: "main",
    projection,
  });
  planning.freeze();
  expect(planning.sessionEntries.entriesForCatalog?.()).toHaveLength(5);
  const instances = new Map();
  for (const host of hosts) {
    planning.captureHostInstances(host, instances);
  }
  const delivery = createSessionCatalogRequestEntrySnapshot({
    cfg,
    fallbackAgentId: "main",
    projection,
    sessionKeys: hosts.flatMap((host) => host.sessions.map((session) => session.sessionKey)),
  });
  expect(hosts.map((host) => delivery.projectHostSessions(host, instances))).toEqual(hosts);
  expect(
    delivery.sessionEntries.entriesForAgent("main").map(({ sessionKey }) => sessionKey),
  ).toEqual(["agent:main:main", "global"]);
  expect(
    delivery.sessionEntries.entriesForAgent("work").map(({ sessionKey }) => sessionKey),
  ).toEqual(["agent:work:main"]);
});
