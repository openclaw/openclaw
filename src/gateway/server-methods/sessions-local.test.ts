import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { cleanupTempDirs, makeTempDir } from "../../../test/helpers/temp-dir.js";
import {
  activateLocalSessionConnectIntent,
  listLocalSessionEnrollments,
} from "../../state/local-session-enrollments.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { sessionsLocalHandlers } from "./sessions-local.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

vi.mock("./device-pair-setup.js", () => ({
  mintNodeJoinUrl: async () => ({
    ok: true,
    setupId: "setup-1",
    expiresAtMs: Date.now() + 600_000,
    joinUrl: "https://gateway.test/j/abcdefghijklmnopqrstuv",
  }),
}));

// Order of the stop-sharing steps: the device must drop the thread before the row goes.
const stopSteps: string[] = [];
const bridge = {
  unshare: vi.fn(async () => {
    stopSteps.push("unshare");
  }),
  onEnrollmentChanged: vi.fn(),
};
vi.mock("../local-sessions/bridge.js", () => ({
  listRegisteredLocalSessionSources: () => [
    {
      pluginId: "codex",
      sourceId: "codex",
      label: "Codex",
      command: "codex.localSessions.source.v1",
    },
  ],
  getLocalSessionBridge: () => bridge,
}));

// Projection removal goes through the canonical delete method; the store itself is
// not under test here, so the delete handler and the row listing are recorded.
const deletedKeys: string[] = [];
let deleteOutcome = true;
vi.mock("./sessions-delete.js", () => ({
  sessionDeleteHandlers: {
    "sessions.delete": async ({
      params,
      respond,
    }: {
      params: { key: string };
      respond: (ok: boolean, payload?: unknown) => void;
    }) => {
      deletedKeys.push(params.key);
      stopSteps.push("delete");
      respond(deleteOutcome, deleteOutcome ? { deleted: true } : undefined);
    },
  },
}));
const projectedRows: Array<{ sessionKey: string; entry: Record<string, unknown> }> = [];
vi.mock("../../config/sessions/session-accessor.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../config/sessions/session-accessor.js")>()),
  listSessionEntriesCore: () => projectedRows,
}));
const loadedEntries = new Map<string, Record<string, unknown>>();
vi.mock("../session-utils.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../session-utils.js")>()),
  loadSessionEntry: (key: string) => ({ entry: loadedEntries.get(key), storePath: "/store" }),
}));

const tempDirs: string[] = [];

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  vi.unstubAllEnvs();
  deletedKeys.length = 0;
  deleteOutcome = true;
  projectedRows.length = 0;
  loadedEntries.clear();
  stopSteps.length = 0;
});

function request(
  method: string,
  params: Record<string, unknown>,
  profile: { profileId: string; displayName: string },
) {
  const respond = vi.fn();
  const options = {
    params,
    respond,
    client: { authenticatedUserProfile: profile, connect: { scopes: ["operator.write"] } },
    context: { broadcast: vi.fn() },
    // SAFETY: the handlers read only the fields stubbed above.
  } as unknown as GatewayRequestHandlerOptions;
  return Promise.resolve(sessionsLocalHandlers[method]!(options)).then(
    () => respond.mock.calls[0] ?? [],
  );
}

afterAll(() => {
  cleanupTempDirs(tempDirs);
});

function enroll(
  profile: { profileId: string; displayName: string },
  scopes: string[],
  agentId = "main",
) {
  const respond = vi.fn();
  const options = {
    params: { deviceId: "device-1", sourceId: "codex", agentId },
    respond,
    client: { authenticatedUserProfile: profile, connect: { scopes } },
    context: {
      nodeRegistry: { get: () => ({ commands: ["codex.localSessions.source.v1"] }) },
      broadcast: vi.fn(),
    },
    // SAFETY: the handler reads only the fields stubbed above; the rest of the request surface is unused here.
  } as unknown as GatewayRequestHandlerOptions;
  return Promise.resolve(sessionsLocalHandlers["sessions.local.enroll"]!(options)).then(
    () => respond.mock.calls[0] ?? [],
  );
}

describe("sessions.local.enroll", () => {
  it("lets only the owner or an admin replace a live share on the same device and source", async () => {
    vi.stubEnv("OPENCLAW_STATE_DIR", makeTempDir(tempDirs, "sessions-local-"));
    // A running Gateway always has its state database; the first enroll reads before it writes.
    openOpenClawStateDatabase();
    const [ok] = await enroll({ profileId: "alice", displayName: "Alice" }, ["operator.write"]);
    expect(ok).toBe(true);

    const [refused, , error] = await enroll({ profileId: "bob", displayName: "Bob" }, [
      "operator.write",
    ]);
    expect(refused).toBe(false);
    expect(error).toMatchObject({ message: expect.stringContaining("already shared by Alice") });
    expect(listLocalSessionEnrollments({ deviceId: "device-1" }).map((row) => row.state)).toEqual([
      "pending",
    ]);

    const [adminOk] = await enroll({ profileId: "bob", displayName: "Bob" }, [
      "operator.write",
      "operator.admin",
    ]);
    expect(adminOk).toBe(true);
    expect(
      listLocalSessionEnrollments({ deviceId: "device-1" }).map((row) => [
        row.ownerProfileId,
        row.state,
      ]),
    ).toEqual(
      expect.arrayContaining([
        ["alice", "revoked"],
        ["bob", "pending"],
      ]),
    );
  });

  it("mints a connect command bound to the caller's profile and the chosen sources", async () => {
    vi.stubEnv("OPENCLAW_STATE_DIR", makeTempDir(tempDirs, "sessions-local-"));
    openOpenClawStateDatabase();
    const respond = vi.fn();
    await sessionsLocalHandlers["sessions.local.connectCode"]!({
      params: { sourceIds: ["codex"], agentId: "main" },
      respond,
      client: {
        authenticatedUserProfile: { profileId: "alice", displayName: "Alice" },
        connect: { scopes: ["operator.write"] },
      },
      context: { broadcast: vi.fn() },
      // SAFETY: the handler reads only the stubbed request fields.
    } as unknown as GatewayRequestHandlerOptions);
    expect(respond.mock.calls[0]?.[0]).toBe(true);
    expect(respond.mock.calls[0]?.[1]).toMatchObject({
      setupId: "setup-1",
      command:
        "npx openclaw connect https://gateway.test/j/abcdefghijklmnopqrstuv --share codex --share-request setup-1",
    });
    // The paired laptop redeems the setup: the intent becomes Alice's enrollment, once.
    expect(
      activateLocalSessionConnectIntent({ setupId: "setup-1", deviceId: "device-9" }),
    ).toMatchObject({ ownerProfileId: "alice", sourceIds: ["codex"], agentId: "main" });
    expect(activateLocalSessionConnectIntent({ setupId: "setup-1", deviceId: "device-9" })).toBe(
      undefined,
    );
  });

  it("rejects unknown sources without minting", async () => {
    vi.stubEnv("OPENCLAW_STATE_DIR", makeTempDir(tempDirs, "sessions-local-"));
    openOpenClawStateDatabase();
    const respond = vi.fn();
    await sessionsLocalHandlers["sessions.local.connectCode"]!({
      params: { sourceIds: ["gemini"], agentId: "main" },
      respond,
      client: {
        authenticatedUserProfile: { profileId: "alice", displayName: "Alice" },
        connect: { scopes: ["operator.write"] },
      },
      context: { broadcast: vi.fn() },
      // SAFETY: the handler reads only the stubbed request fields.
    } as unknown as GatewayRequestHandlerOptions);
    expect(respond.mock.calls[0]?.[0]).toBe(false);
    expect(respond.mock.calls[0]?.[2]).toMatchObject({
      message: expect.stringContaining("gemini"),
    });
  });
});

describe("stopping a share removes what it projected", () => {
  const alice = { profileId: "alice", displayName: "Alice" };
  const localSource = (enrollmentId: string, threadId: string, deviceId = "device-1") => ({
    pluginId: "codex",
    sourceId: "codex",
    deviceId,
    threadId,
    enrollmentId,
  });
  const ownedBy = (profileId: string) => ({
    createdActor: { type: "human", id: profileId, label: profileId, source: "profile" },
  });

  it("revoke deletes every row the enrollment projected and leaves other shares alone", async () => {
    vi.stubEnv("OPENCLAW_STATE_DIR", makeTempDir(tempDirs, "sessions-local-"));
    openOpenClawStateDatabase();
    const [, enrolled] = await enroll(alice, ["operator.write"]);
    const enrollmentId = (enrolled as { enrollment: { enrollmentId: string } }).enrollment
      .enrollmentId;
    projectedRows.push(
      {
        sessionKey: "agent:main:local:codex:device-1:alice:t1",
        entry: { localSource: localSource(enrollmentId, "t1"), ...ownedBy("alice") },
      },
      // Still tagged with the enrollment a re-share replaced: it is Alice's row all the same.
      {
        sessionKey: "agent:main:local:codex:device-1:alice:t2",
        entry: { localSource: localSource("enrollment-before-reshare", "t2"), ...ownedBy("alice") },
      },
      {
        sessionKey: "agent:main:local:codex:device-2:alice:t3",
        entry: { localSource: localSource("other-device", "t3", "device-2"), ...ownedBy("alice") },
      },
      {
        sessionKey: "agent:main:local:codex:device-1:bob:t9",
        entry: { localSource: localSource("bobs", "t9"), ...ownedBy("bob") },
      },
      { sessionKey: "agent:main:main", entry: {} },
    );
    const [ok, payload] = await request("sessions.local.revoke", { enrollmentId }, alice);
    expect(ok).toBe(true);
    expect(payload).toMatchObject({ enrollment: { state: "revoked" } });
    expect(deletedKeys).toEqual([
      "agent:main:local:codex:device-1:alice:t1",
      "agent:main:local:codex:device-1:alice:t2",
    ]);
  });

  it("an admin replacing someone's share removes that person's projections", async () => {
    vi.stubEnv("OPENCLAW_STATE_DIR", makeTempDir(tempDirs, "sessions-local-"));
    openOpenClawStateDatabase();
    await enroll(alice, ["operator.write"]);
    projectedRows.push(
      {
        sessionKey: "agent:main:local:codex:device-1:alice:t1",
        entry: { localSource: localSource("any", "t1"), ...ownedBy("alice") },
      },
      {
        sessionKey: "agent:main:local:codex:device-1:bob:t2",
        entry: { localSource: localSource("bobs", "t2"), ...ownedBy("bob") },
      },
    );
    const [ok] = await enroll({ profileId: "bob", displayName: "Bob" }, [
      "operator.write",
      "operator.admin",
    ]);
    expect(ok).toBe(true);
    expect(deletedKeys).toEqual(["agent:main:local:codex:device-1:alice:t1"]);
    // Re-sharing your own source keeps your rows; the device re-tags them on resume.
    deletedKeys.length = 0;
    const [again] = await enroll({ profileId: "bob", displayName: "Bob" }, ["operator.write"]);
    expect(again).toBe(true);
    expect(deletedKeys).toEqual([]);
    // Moving it to another agent leaves nothing behind in the old agent's store.
    const [moved] = await enroll(
      { profileId: "bob", displayName: "Bob" },
      ["operator.write"],
      "review",
    );
    expect(moved).toBe(true);
    expect(deletedKeys).toEqual(["agent:main:local:codex:device-1:bob:t2"]);
  });

  it("unshare tells the device first, then deletes the row", async () => {
    vi.stubEnv("OPENCLAW_STATE_DIR", makeTempDir(tempDirs, "sessions-local-"));
    openOpenClawStateDatabase();
    const sessionKey = "agent:main:local:codex:device-1:alice:t1";
    loadedEntries.set(sessionKey, {
      localSource: localSource("enrollment-1", "t1"),
      createdActor: { type: "human", id: "alice", label: "Alice", source: "profile" },
    });
    const [ok] = await request("sessions.local.unshare", { sessionKey }, alice);
    expect(ok).toBe(true);
    expect(stopSteps).toEqual(["unshare", "delete"]);
    expect(deletedKeys).toEqual([sessionKey]);
  });

  it("reports a row that could not be removed instead of claiming success", async () => {
    vi.stubEnv("OPENCLAW_STATE_DIR", makeTempDir(tempDirs, "sessions-local-"));
    openOpenClawStateDatabase();
    const sessionKey = "agent:main:local:codex:device-1:alice:t1";
    loadedEntries.set(sessionKey, {
      localSource: localSource("enrollment-1", "t1"),
      createdActor: { type: "human", id: "alice", label: "Alice", source: "profile" },
    });
    deleteOutcome = false;
    const [ok, , error] = await request("sessions.local.unshare", { sessionKey }, alice);
    expect(ok).toBe(false);
    expect(error).toMatchObject({ message: expect.stringContaining(sessionKey) });
  });
});
