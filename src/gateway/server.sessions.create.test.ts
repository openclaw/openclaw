import { expect, test } from "vitest";
import { getSessionEntry } from "../config/sessions.js";
import { loadSqliteSessionTranscriptEvents } from "../config/sessions/transcript-store.sqlite.js";
import { piSdkMock, rpcReq, testState, seedGatewaySessionEntries } from "./test-helpers.js";
import {
  setupGatewaySessionsTestHarness,
  sessionStoreEntry,
  directSessionReq,
} from "./test/server-sessions.test-helpers.js";

const { createSessionStoreDir, openClient } = setupGatewaySessionsTestHarness();

function requireNonEmptyString(value: string | undefined, label: string): string {
  if (!value) {
    throw new Error(`expected ${label}`);
  }
  return value;
}

test("sessions.create stores dashboard session model and parent linkage, and creates a transcript", async () => {
  await createSessionStoreDir();
  piSdkMock.enabled = true;
  piSdkMock.models = [{ id: "gpt-test-a", name: "A", provider: "openai" }];
  await seedGatewaySessionEntries({
    entries: {
      main: sessionStoreEntry("sess-parent"),
    },
  });
  const created = await directSessionReq<{
    key?: string;
    sessionId?: string;
    entry?: {
      label?: string;
      providerOverride?: string;
      modelOverride?: string;
      parentSessionKey?: string;
      sessionFile?: string;
    };
  }>("sessions.create", {
    agentId: "ops",
    label: "Dashboard Chat",
    model: "openai/gpt-test-a",
    parentSessionKey: "main",
  });

  expect(created.ok, JSON.stringify(created.error)).toBe(true);
  expect(created.payload?.key).toMatch(/^agent:ops:dashboard:/);
  expect(created.payload?.entry?.label).toBe("Dashboard Chat");
  expect(created.payload?.entry?.providerOverride).toBe("openai");
  expect(created.payload?.entry?.modelOverride).toBe("gpt-test-a");
  expect(created.payload?.entry?.parentSessionKey).toBe("agent:main:main");
  const sessionFile = requireNonEmptyString(
    created.payload?.entry?.sessionFile,
    "created session file",
  );
  expect(created.payload?.sessionId).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
  );

  const key = created.payload?.key as string;
  const stored = getSessionEntry({ agentId: "ops", sessionKey: key });
  expect(stored).toMatchObject({
    sessionId: created.payload?.sessionId,
    label: "Dashboard Chat",
    providerOverride: "openai",
    modelOverride: "gpt-test-a",
    parentSessionKey: "agent:main:main",
  });
  expect(created.payload?.entry?.sessionFile).toBe(stored?.sessionFile);

  const [header] = loadSqliteSessionTranscriptEvents({
    agentId: "ops",
    sessionId: created.payload?.sessionId ?? "",
  });
  expect(header?.event as { type?: string; id?: string }).toMatchObject({
    type: "session",
    id: created.payload?.sessionId,
  });
});

test("sessions.create accepts an explicit key for persistent dashboard sessions", async () => {
  await createSessionStoreDir();

  const key = "agent:ops-agent:dashboard:direct:subagent-orchestrator";
  const created = await directSessionReq<{
    key?: string;
    sessionId?: string;
    entry?: {
      label?: string;
    };
  }>("sessions.create", {
    key,
    label: "Dashboard Orchestrator",
  });

  expect(created.ok, JSON.stringify(created.error)).toBe(true);
  expect(created.payload?.key).toBe(key);
  expect(created.payload?.entry?.label).toBe("Dashboard Orchestrator");
  expect(created.payload?.sessionId).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
  );
});

test("sessions.create scopes the main alias to the requested agent", async () => {
  await createSessionStoreDir();

  const created = await directSessionReq<{
    key?: string;
    sessionId?: string;
    entry?: {
      sessionFile?: string;
    };
  }>("sessions.create", {
    key: "main",
    agentId: "longmemeval",
  });

  expect(created.ok, JSON.stringify(created.error)).toBe(true);
  expect(created.payload?.key).toBe("agent:longmemeval:main");
  requireNonEmptyString(created.payload?.entry?.sessionFile, "longmemeval session file");

  expect(
    getSessionEntry({ agentId: "longmemeval", sessionKey: "agent:longmemeval:main" })?.sessionId,
  ).toBe(created.payload?.sessionId);
  expect(getSessionEntry({ agentId: "main", sessionKey: "agent:main:main" })?.sessionId).not.toBe(
    created.payload?.sessionId,
  );
});

test("sessions.create preserves global and unknown sentinel keys", async () => {
  await createSessionStoreDir();

  const globalCreated = await directSessionReq<{
    key?: string;
    sessionId?: string;
    entry?: {
      sessionFile?: string;
    };
  }>("sessions.create", {
    key: "global",
    agentId: "longmemeval",
  });

  expect(globalCreated.ok).toBe(true);
  expect(globalCreated.payload?.key).toBe("global");
  requireNonEmptyString(globalCreated.payload?.entry?.sessionFile, "global session file");

  const unknownCreated = await directSessionReq<{
    key?: string;
    sessionId?: string;
    entry?: {
      sessionFile?: string;
    };
  }>("sessions.create", {
    key: "unknown",
    agentId: "longmemeval",
  });

  expect(unknownCreated.ok).toBe(true);
  expect(unknownCreated.payload?.key).toBe("unknown");
  requireNonEmptyString(unknownCreated.payload?.entry?.sessionFile, "unknown session file");

  expect(getSessionEntry({ agentId: "main", sessionKey: "global" })?.sessionId).toBe(
    globalCreated.payload?.sessionId,
  );
  expect(getSessionEntry({ agentId: "main", sessionKey: "unknown" })?.sessionId).toBe(
    unknownCreated.payload?.sessionId,
  );
  expect(
    getSessionEntry({ agentId: "longmemeval", sessionKey: "agent:longmemeval:global" }),
  ).toBeUndefined();
  expect(
    getSessionEntry({ agentId: "longmemeval", sessionKey: "agent:longmemeval:unknown" }),
  ).toBeUndefined();
});

test("sessions.create rejects unknown parentSessionKey", async () => {
  await createSessionStoreDir();

  const created = await directSessionReq("sessions.create", {
    agentId: "ops",
    parentSessionKey: "agent:main:missing",
  });

  expect(created.ok).toBe(false);
  expect((created.error as { message?: string } | undefined)?.message ?? "").toContain(
    "unknown parent session",
  );
});

test("sessions.create can start the first agent turn from an initial task", async () => {
  await createSessionStoreDir();
  // Register "ops" so the deleted-agent guard added in #65986 does not
  // reject the auto-started chat.send triggered by `task:`.
  testState.agentsConfig = { list: [{ id: "ops", default: true }] };
  const { ws } = await openClient();

  const created = await rpcReq<{
    key?: string;
    sessionId?: string;
    runStarted?: boolean;
    runId?: string;
    messageSeq?: number;
  }>(ws, "sessions.create", {
    agentId: "ops",
    label: "Dashboard Task Chat",
    task: "hello from create",
  });

  expect(created.ok, JSON.stringify(created.error)).toBe(true);
  expect(created.payload?.key).toMatch(/^agent:ops:dashboard:/);
  expect(created.payload?.sessionId).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
  );
  expect(created.payload?.runStarted).toBe(true);
  requireNonEmptyString(created.payload?.runId, "started run id");
  expect(created.payload?.messageSeq).toBe(1);

  ws.close();
});
