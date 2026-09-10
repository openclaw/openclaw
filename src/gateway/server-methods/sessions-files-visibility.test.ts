import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { createTempHomeEnv, type TempHomeEnv } from "../../test-utils/temp-home.js";
import { prepareSessionCreatorProfile } from "../session-creator.js";
import { createProfileSessionEntryFilter } from "../session-sharing.js";
import { sessionsDiffHandlers } from "./sessions-diff.js";
import { sessionsFilesHandlers } from "./sessions-files.js";
import {
  createVisibleMessagesMock,
  prepareSessionFilesTest,
  removeWorkspaceFixture,
} from "./sessions-files.test-support.js";
import type { GatewayRequestHandlers, RespondFn } from "./types.js";

const hoisted = vi.hoisted(() => ({
  execOpenPath: vi.fn(),
  loadSessionEntry: vi.fn(),
  resolveAgentWorkspaceDir: vi.fn(),
  resolveDefaultAgentId: vi.fn(),
  readSessionTranscriptVisibleMessageDeltaCore: vi.fn(),
}));

vi.mock("./open-path.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./open-path.js")>()),
  execOpenPath: hoisted.execOpenPath,
}));

vi.mock("../../agents/agent-scope.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../agents/agent-scope.js")>()),
  resolveAgentWorkspaceDir: hoisted.resolveAgentWorkspaceDir,
  resolveDefaultAgentId: hoisted.resolveDefaultAgentId,
}));

vi.mock("../session-utils.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../session-utils.js")>()),
  loadSessionEntry: hoisted.loadSessionEntry,
  loadGatewaySessionEntryReadOnly: hoisted.loadSessionEntry,
}));

vi.mock("../session-transcript-readers.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../session-transcript-readers.js")>()),
  readSessionTranscriptVisibleMessageDeltaCore:
    hoisted.readSessionTranscriptVisibleMessageDeltaCore,
}));

const mockVisibleMessages = createVisibleMessagesMock(
  hoisted.readSessionTranscriptVisibleMessageDeltaCore,
);

const SESSION_KEY = "agent:main:main";

const cfg = { agents: { list: [{ id: "main", default: true }] } } as never;
const rolesCfg = {
  agents: { list: [{ id: "main", default: true }] },
  gateway: {
    roles: {
      default: "limited",
      definitions: {
        limited: { sessions: { others: "view" }, agents: "*", scopes: ["operator.read"] },
      },
    },
  },
} as never;
const INCOGNITO_SESSION_KEY = "agent:main:dashboard:incognito-probe";

function operatorClient(profileId: string | undefined, scopes: string[]) {
  return {
    connId: `conn-${profileId ?? "anonymous"}`,
    connect: {
      role: "operator",
      scopes,
      client: { id: "openclaw-control-ui", mode: "operator", version: "1", platform: "linux" },
    },
    ...(profileId ? { authenticatedUserProfile: { profileId } } : {}),
  } as never;
}

let ALICE: string;
let BOB: string;
let bobClient: unknown;
let aliceClient: unknown;
let adminClient: unknown;
const unidentifiedClient = operatorClient(undefined, ["operator.read"]);

async function invoke(
  handlers: GatewayRequestHandlers,
  method: string,
  params: Record<string, unknown>,
  client: unknown,
  runtimeCfg: unknown = cfg,
) {
  const calls: { ok: boolean; payload?: unknown; error?: unknown }[] = [];
  const respond: RespondFn = (ok, payload, error) => {
    calls.push({ ok, payload, error });
  };
  await handlers[method]?.({
    req: { type: "req", id: method, method, params: {} },
    params,
    client,
    isWebchatConnect: () => false,
    respond,
    context: { getRuntimeConfig: () => runtimeCfg } as never,
  } as never);
  expect(calls).toHaveLength(1);
  return calls[0] as { ok: boolean; payload?: any; error?: any };
}

function readSessionAs(
  client: unknown,
  runtimeCfg: unknown = cfg,
  sessionKey: string = SESSION_KEY,
) {
  return {
    list: () =>
      invoke(sessionsFilesHandlers, "sessions.files.list", { sessionKey }, client, runtimeCfg),
    get: () =>
      invoke(
        sessionsFilesHandlers,
        "sessions.files.get",
        { sessionKey, path: "src/readme.md" },
        client,
        runtimeCfg,
      ),
    diff: () => invoke(sessionsDiffHandlers, "sessions.diff", { sessionKey }, client, runtimeCfg),
  };
}

describe("session read-by-key visibility for sessions.files.* and sessions.diff", () => {
  let workspaceRoot: string;
  let home: TempHomeEnv;

  beforeEach(async () => {
    home = await createTempHomeEnv("openclaw-session-files-visibility-");
    ALICE = ensureProfileForEmail("files-visibility-alice@example.test").id;
    BOB = ensureProfileForEmail("files-visibility-bob@example.test").id;
    aliceClient = operatorClient(ALICE, ["operator.read"]);
    bobClient = operatorClient(BOB, ["operator.read"]);
    adminClient = operatorClient(ensureProfileForEmail("files-visibility-admin@example.test").id, [
      "operator.read",
      "operator.admin",
    ]);
    workspaceRoot = prepareSessionFilesTest(hoisted, mockVisibleMessages);
    hoisted.loadSessionEntry.mockReturnValue({
      agentId: "main",
      canonicalKey: SESSION_KEY,
      cfg,
      storePath: path.join(workspaceRoot, ".sessions.json"),
      entry: {
        sessionId: "sess-main",
        sessionFile: "sess-main.jsonl",
        spawnedCwd: workspaceRoot,
        visibility: "draft",
        createdActor: { type: "human", source: "profile", id: ALICE },
      },
    });
  });

  afterEach(async () => {
    removeWorkspaceFixture(workspaceRoot);
    closeOpenClawStateDatabaseForTest();
    await home.restore();
  });

  it("hides the fixture session from a non-creator under the shared sharing predicate", () => {
    const entryFilter = createProfileSessionEntryFilter(
      { profileId: BOB },
      prepareSessionCreatorProfile(BOB, new Set<string>()),
    );
    expect(
      entryFilter(SESSION_KEY, {
        createdActor: { type: "human", source: "profile", id: ALICE },
        visibility: "draft",
      } as never),
    ).toBe(false);
  });

  it("refuses sessions.files.list, sessions.files.get and sessions.diff for a non-creator under operator roles", async () => {
    const bob = readSessionAs(bobClient, rolesCfg);

    const list = await bob.list();
    expect(list.ok).toBe(false);
    expect(list.payload).toBeUndefined();
    expect(String(list.error?.message)).toContain("was not found");

    const get = await bob.get();
    expect(get.ok).toBe(false);
    expect(get.payload).toBeUndefined();

    const diff = await bob.diff();
    expect(diff.ok).toBe(false);
    expect(diff.payload).toBeUndefined();
  }, 600_000);

  it("still serves the session creator under operator roles", async () => {
    const alice = readSessionAs(aliceClient, rolesCfg);

    const list = await alice.list();
    expect(list.ok).toBe(true);
    expect(list.payload?.root).toBe(workspaceRoot);
    expect(list.payload?.files?.length).toBeGreaterThan(0);

    const get = await alice.get();
    expect(get.ok).toBe(true);
    expect(get.payload?.file?.content).toBe("# Read me\n");

    expect((await alice.diff()).ok).toBe(true);
  }, 600_000);

  it("still serves a gateway admin under operator roles", async () => {
    const admin = readSessionAs(adminClient, rolesCfg);

    expect((await admin.list()).payload?.root).toBe(workspaceRoot);
    expect((await admin.get()).payload?.file?.content).toBe("# Read me\n");
    expect((await admin.diff()).ok).toBe(true);
  }, 600_000);

  it("leaves an unidentified single-user gateway caller unaffected", async () => {
    const owner = readSessionAs(unidentifiedClient);

    expect((await owner.list()).payload?.root).toBe(workspaceRoot);
    expect((await owner.get()).payload?.file?.content).toBe("# Read me\n");
    expect((await owner.diff()).ok).toBe(true);
  }, 600_000);

  it("preserves foreign draft reads for an identified caller when no operator roles exist", async () => {
    const bob = readSessionAs(bobClient);

    const list = await bob.list();
    expect(list.ok).toBe(true);
    expect(list.payload?.root).toBe(workspaceRoot);
    expect(list.payload?.files?.length).toBeGreaterThan(0);

    const get = await bob.get();
    expect(get.ok).toBe(true);
    expect(get.payload?.file?.content).toBe("# Read me\n");

    expect((await bob.diff()).ok).toBe(true);
  }, 600_000);

  it("still refuses an incognito session for an identified caller without operator roles", async () => {
    hoisted.loadSessionEntry.mockReturnValue({
      agentId: "main",
      canonicalKey: INCOGNITO_SESSION_KEY,
      cfg,
      storePath: path.join(workspaceRoot, ".sessions.json"),
      entry: {
        sessionId: "sess-incognito",
        sessionFile: "sess-incognito.jsonl",
        spawnedCwd: workspaceRoot,
        incognito: true,
        createdActor: { type: "human", source: "profile", id: ALICE },
      },
    });
    const bob = readSessionAs(bobClient, cfg, INCOGNITO_SESSION_KEY);

    const list = await bob.list();
    expect(list.ok).toBe(false);
    expect(String(list.error?.message)).toContain("was not found");

    expect((await bob.get()).ok).toBe(false);
    expect((await bob.diff()).ok).toBe(false);
  }, 600_000);

  it("keeps the unknown-session response shape for a missing session", async () => {
    hoisted.loadSessionEntry.mockReturnValue({
      agentId: "main",
      canonicalKey: SESSION_KEY,
      cfg,
      storePath: undefined,
      entry: undefined,
    });

    const bob = readSessionAs(bobClient, rolesCfg);
    const list = await bob.list();
    expect(list.ok).toBe(true);
    expect(list.payload?.files).toEqual([]);

    const get = await bob.get();
    expect(get.ok).toBe(false);
    expect(get.error?.details?.path).toBe("src/readme.md");
  }, 600_000);
});
