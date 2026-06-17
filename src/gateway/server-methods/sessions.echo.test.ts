/**
 * Tests the sessions.echo gateway handler (add/remove/list subcommands) against
 * a real on-disk temp session store, including the key-resolution invariant that
 * list and remove operate on the same persisted row a session was created under
 * (agent:<id>:main) rather than orphaning a second row.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ErrorCodes } from "../../../packages/gateway-protocol/src/index.js";
import type { SessionEntry } from "../../config/sessions/types.js";

// The echo handler reads/writes through loadSessionEntry (session-utils) and
// patchSessionEntry (session-accessor), both of which resolve the store path via
// getRuntimeConfig().session.store. Point that at a per-test temp directory so a
// real JSON store backs the handler instead of the user's live sessions.
const runtimeConfig: { session: { store: string }; agents?: { list?: Array<{ id: string }> } } = {
  session: { store: "" },
};

vi.mock("../../config/io.js", async () => {
  const actual = await vi.importActual<typeof import("../../config/io.js")>("../../config/io.js");
  return {
    ...actual,
    getRuntimeConfig: () => runtimeConfig,
  };
});

import { sessionsHandlers } from "./sessions.js";
import type { GatewayRequestContext, RespondFn } from "./types.js";

const DEFAULT_AGENT_ID = "main";

let tmpRoot: string;
let storePath: string;

function resolvedStorePath(agentId: string): string {
  return path.join(tmpRoot, "agents", agentId, "sessions", "sessions.json");
}

function seedStore(entries: Record<string, SessionEntry>): void {
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  fs.writeFileSync(storePath, JSON.stringify(entries, null, 2), "utf-8");
}

function readStore(): Record<string, SessionEntry> {
  if (!fs.existsSync(storePath)) {
    return {};
  }
  return JSON.parse(fs.readFileSync(storePath, "utf-8")) as Record<string, SessionEntry>;
}

function participantEntry(overrides: Partial<SessionEntry> = {}): SessionEntry {
  return {
    sessionId: "sess-echo-1",
    updatedAt: Date.now(),
    channel: "telegram",
    lastChannel: "telegram",
    lastTo: "123456",
    ...overrides,
  };
}

function createContext(): GatewayRequestContext {
  return {
    chatAbortControllers: new Map(),
    getRuntimeConfig: () => runtimeConfig,
    // Empty subscriber set short-circuits emitSessionsChanged before any broadcast,
    // keeping the assertions about the persisted store rather than event plumbing.
    getSessionEventSubscriberConnIds: () => new Set<string>(),
    broadcastToConnIds: vi.fn(),
  } as unknown as GatewayRequestContext;
}

async function callEcho(
  params: Record<string, unknown>,
): Promise<{ respond: RespondFn; ok: boolean; result: unknown; error: unknown }> {
  const respond = vi.fn() as unknown as RespondFn;
  await sessionsHandlers["sessions.echo"]({
    req: { id: "req-echo" } as never,
    params,
    respond,
    context: createContext(),
    client: null,
    isWebchatConnect: () => false,
  });
  const call = (respond as unknown as { mock: { calls: unknown[][] } }).mock.calls[0];
  return {
    respond,
    ok: call?.[0] as boolean,
    result: call?.[1],
    error: call?.[2],
  };
}

const telegramTarget = { channel: "telegram", to: "123456" };

beforeAll(() => {
  // Disable the session-store object/snapshot cache so each handler call reads
  // the freshest on-disk state instead of a TTL-cached snapshot. The store is
  // mtime-keyed so this is belt-and-suspenders, but it removes timing flake.
  process.env.OPENCLAW_SESSION_CACHE_TTL_MS = "0";
});

afterAll(() => {
  delete process.env.OPENCLAW_SESSION_CACHE_TTL_MS;
});

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "oc-echo-store-"));
  // {agentId} template expansion is the only supported way to share one store
  // path across agent stores; the handler resolves it per requested agent.
  runtimeConfig.session.store = path.join(
    tmpRoot,
    "agents",
    "{agentId}",
    "sessions",
    "sessions.json",
  );
  delete runtimeConfig.agents;
  storePath = resolvedStorePath(DEFAULT_AGENT_ID);
});

afterEach(() => {
  if (tmpRoot && fs.existsSync(tmpRoot)) {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

describe("sessions.echo against a real temp store", () => {
  it("lists the empty echo target set for an existing session", async () => {
    seedStore({ "agent:main:main": participantEntry() });

    const { ok, result } = await callEcho({ key: "agent:main:main", action: "list" });

    expect(ok).toBe(true);
    expect(result).toEqual({ echoTargets: [] });
  });

  it("lists existing echo targets without mutating the store", async () => {
    seedStore({
      "agent:main:main": participantEntry({
        echoTargets: [{ channel: "telegram", to: "123456", addedAt: 1 }],
      }),
    });

    const { ok, result } = await callEcho({ key: "agent:main:main", action: "list" });

    expect(ok).toBe(true);
    expect(result).toEqual({
      echoTargets: [{ channel: "telegram", to: "123456", addedAt: 1 }],
    });
    // list must not touch the persisted row.
    expect(readStore()["agent:main:main"]?.echoTargets).toHaveLength(1);
  });

  it("adds a participant target and persists it (changed: true)", async () => {
    seedStore({ "agent:main:main": participantEntry() });

    const { ok, result } = await callEcho({
      key: "agent:main:main",
      action: "add",
      ...telegramTarget,
    });

    expect(ok).toBe(true);
    expect(result).toMatchObject({ changed: true });
    expect((result as { echoTargets: unknown[] }).echoTargets).toHaveLength(1);

    const persisted = readStore()["agent:main:main"]?.echoTargets;
    expect(persisted).toHaveLength(1);
    expect(persisted?.[0]).toMatchObject({ channel: "telegram", to: "123456" });
    expect(typeof persisted?.[0]?.addedAt).toBe("number");
  });

  it("treats a duplicate add as a no-op (changed: false)", async () => {
    seedStore({
      "agent:main:main": participantEntry({
        echoTargets: [{ channel: "telegram", to: "123456", addedAt: 5 }],
      }),
    });

    const { ok, result } = await callEcho({
      key: "agent:main:main",
      action: "add",
      ...telegramTarget,
    });

    expect(ok).toBe(true);
    expect(result).toMatchObject({ changed: false });
    expect((result as { echoTargets: unknown[] }).echoTargets).toHaveLength(1);
    // The original addedAt must survive (no re-add overwriting the row).
    expect(readStore()["agent:main:main"]?.echoTargets?.[0]?.addedAt).toBe(5);
  });

  it("rejects an add at the 16-target cap with an at-limit error", async () => {
    const echoTargets = Array.from({ length: 16 }, (_, index) => ({
      channel: "telegram",
      to: `chat-${index}`,
      addedAt: index,
    }));
    seedStore({ "agent:main:main": participantEntry({ echoTargets }) });

    const { ok, error } = await callEcho({
      key: "agent:main:main",
      action: "add",
      ...telegramTarget,
    });

    expect(ok).toBe(false);
    expect(error).toMatchObject({
      code: ErrorCodes.INVALID_REQUEST,
      message: "Echo target limit reached (max 16)",
    });
    // The capped row must be untouched.
    expect(readStore()["agent:main:main"]?.echoTargets).toHaveLength(16);
  });

  it("rejects a non-participant add target", async () => {
    seedStore({ "agent:main:main": participantEntry() });

    const { ok, error } = await callEcho({
      key: "agent:main:main",
      action: "add",
      channel: "telegram",
      to: "999999", // not the bound participant thread
    });

    expect(ok).toBe(false);
    expect(error).toMatchObject({ code: ErrorCodes.INVALID_REQUEST });
    expect((error as { message: string }).message).toContain(
      "must be a thread bound to this session",
    );
    // Nothing should have been written.
    expect(readStore()["agent:main:main"]?.echoTargets).toBeUndefined();
  });

  it("deletes the echoTargets field when the last target is removed", async () => {
    seedStore({
      "agent:main:main": participantEntry({
        echoTargets: [{ channel: "telegram", to: "123456", addedAt: 9 }],
      }),
    });

    const { ok, result } = await callEcho({
      key: "agent:main:main",
      action: "remove",
      ...telegramTarget,
    });

    expect(ok).toBe(true);
    expect(result).toEqual({ changed: true, echoTargets: [] });
    // Removing the last target must drop the field, not leave a stale empty array.
    expect(Object.hasOwn(readStore()["agent:main:main"] ?? {}, "echoTargets")).toBe(false);
  });

  it("treats removing a non-existent target as a no-op (changed: false)", async () => {
    seedStore({
      "agent:main:main": participantEntry({
        echoTargets: [{ channel: "telegram", to: "123456", addedAt: 3 }],
      }),
    });

    const { ok, result } = await callEcho({
      key: "agent:main:main",
      action: "remove",
      channel: "telegram",
      to: "000000",
    });

    expect(ok).toBe(true);
    expect(result).toMatchObject({ changed: false });
    expect((result as { echoTargets: unknown[] }).echoTargets).toHaveLength(1);
    // The existing target must remain intact.
    expect(readStore()["agent:main:main"]?.echoTargets?.[0]?.to).toBe("123456");
  });

  it("returns Session not found when adding to a missing session", async () => {
    seedStore({}); // empty store, no row for the key

    const { ok, error } = await callEcho({
      key: "agent:main:main",
      action: "add",
      ...telegramTarget,
    });

    expect(ok).toBe(false);
    expect(error).toMatchObject({ code: ErrorCodes.INVALID_REQUEST });
    expect((error as { message: string }).message).toContain("Session not found");
  });

  it("resolves list and remove to the same agent:<id>:main row (no orphaning)", async () => {
    // The session is persisted under the canonical agent:main:main key with one
    // echo target. Operate via the legacy alias "main" for both list and remove:
    // both must canonicalize back to agent:main:main and act on that single row.
    seedStore({
      "agent:main:main": participantEntry({
        echoTargets: [{ channel: "telegram", to: "123456", addedAt: 11 }],
      }),
    });

    const listed = await callEcho({ key: "main", action: "list" });
    expect(listed.ok).toBe(true);
    expect((listed.result as { echoTargets: unknown[] }).echoTargets).toHaveLength(1);

    const removed = await callEcho({ key: "main", action: "remove", ...telegramTarget });
    expect(removed.ok).toBe(true);
    expect(removed.result).toEqual({ changed: true, echoTargets: [] });

    const store = readStore();
    // Exactly one row, still under the original key, with no stale echoTargets.
    expect(Object.keys(store)).toEqual(["agent:main:main"]);
    expect(Object.hasOwn(store["agent:main:main"] ?? {}, "echoTargets")).toBe(false);
  });
});
