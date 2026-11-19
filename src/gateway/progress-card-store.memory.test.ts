import { afterEach, expect, it, vi } from "vitest";
import { memorySessionActorOwners } from "../config/sessions/session-actor-memory-owner.js";
import { readSessionActorStorageResult } from "../config/sessions/session-actor-storage-result.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.paths.js";
import { boardStore } from "./board-store.js";
import { progressCardStore } from "./progress-card-store.js";

vi.mock("../config/io.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config/io.js")>()),
  getRuntimeConfig: () => ({ agents: { entries: { main: {} } } }),
}));
vi.mock("node:sqlite", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:sqlite")>()),
  DatabaseSync: vi.fn(function () {
    throw new Error("Gateway private card opened SQLite");
  }),
}));
vi.mock("node:worker_threads", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:worker_threads")>()),
  Worker: vi.fn(function () {
    throw new Error("Gateway private card allocated a worker");
  }),
}));

const env = { OPENCLAW_STATE_DIR: "/synthetic/gateway-private-cards" };
const sessionKey = "agent:main:dashboard:incognito-cards";
const authority = { assertCurrent() {}, authorize() {} };
afterEach(() => {
  memorySessionActorOwners.reset();
  vi.unstubAllEnvs();
});

it("routes unbound Board and progress-card writes to one memory owner and never recreates deleted sessions", async () => {
  vi.stubEnv("OPENCLAW_STATE_DIR", env.OPENCLAW_STATE_DIR);
  const owner = memorySessionActorOwners.get({
    agentId: "main",
    path: resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main", env }),
  });
  const actor = await owner.acquire(
    { database: owner.identity, sessionKey },
    { assertCurrent() {}, assertReadable() {} },
  );
  try {
    readSessionActorStorageResult(
      await actor.storage!.mutate(
        {
          type: "session.entry.create",
          input: { entry: { sessionId: "cards", incognito: true, updatedAt: 1 } },
        },
        authority,
      ),
    );
    await Promise.all([
      boardStore.putWidget({
        sessionKey,
        name: "one",
        content: { kind: "html", html: "<p>One</p>" },
      }),
      boardStore.putWidget({
        sessionKey,
        name: "two",
        content: { kind: "html", html: "<p>Two</p>" },
      }),
    ]);
    expect(
      (await boardStore.getSnapshot({ sessionKey })).widgets.map((widget) => widget.name),
    ).toEqual(["one", "two"]);
    expect(await progressCardStore.put(sessionKey, { markdown: "Working" })).toMatchObject({
      card: { markdown: "Working", revision: 1 },
    });
    expect(await progressCardStore.get(sessionKey)).toMatchObject({
      markdown: "Working",
      revision: 1,
    });
    await progressCardStore.put(sessionKey, { expectedRevision: 1 });
    expect(await progressCardStore.get(sessionKey)).toBeNull();
    expect(await progressCardStore.put(sessionKey, { markdown: "Next" })).toMatchObject({
      card: { revision: 3 },
    });
    owner.closeSession(sessionKey);
    expect(await progressCardStore.get(sessionKey)).toBeNull();
    await expect(
      progressCardStore.put(sessionKey, { markdown: "Must not recreate" }),
    ).rejects.toMatchObject({ code: "INCOGNITO_SESSION_MISSING" });
    expect((await boardStore.getSnapshot({ sessionKey })).widgets).toEqual([]);
    expect(owner.listSessions(authority)).toEqual([]);
    expect(memorySessionActorOwners.list()).toHaveLength(1);
  } finally {
    await actor.release();
  }
});
