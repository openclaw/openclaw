import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions.js";
import { initSessionState } from "./session.js";

vi.mock("../../agents/session-write-lock.js", () => ({
  acquireSessionWriteLock: async () => ({ release: async () => {} }),
}));

let suiteRoot = "";
let suiteCase = 0;

beforeAll(async () => {
  suiteRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-heartbeat-origin-suite-"));
});

afterAll(async () => {
  await fs.rm(suiteRoot, { recursive: true, force: true });
  suiteRoot = "";
  suiteCase = 0;
});

async function makeStorePath(prefix: string): Promise<string> {
  const dir = path.join(suiteRoot, `${prefix}${++suiteCase}`);
  await fs.mkdir(dir, { recursive: true });
  return path.join(dir, "sessions.json");
}

async function writeSessionStore(
  storePath: string,
  store: Record<string, SessionEntry | Record<string, unknown>>,
): Promise<void> {
  await fs.mkdir(path.dirname(storePath), { recursive: true });
  await fs.writeFile(storePath, JSON.stringify(store), "utf-8");
}

const SESSION_KEY = "agent:main:main";
const ORIGINAL_ORIGIN = {
  label: "My App — Project: Dashboard",
  provider: "webchat",
  surface: "webchat",
  chatType: "direct",
  from: "webchat:user-1",
  to: "webchat:user-1",
} as const;

function buildConfig(storePath: string): OpenClawConfig {
  return {
    session: { store: storePath },
  } as OpenClawConfig;
}

function buildSyntheticCtx(provider: "heartbeat" | "cron-event" | "exec-event") {
  return {
    Body: "Read HEARTBEAT.md and check in.",
    SessionKey: SESSION_KEY,
    Provider: provider,
    Surface: "webchat",
    ChatType: "direct",
    From: provider,
    To: provider,
    OriginatingChannel: "webchat",
    OriginatingTo: "webchat:user-1",
  } as const;
}

async function readPersistedOrigin(storePath: string) {
  const persisted = JSON.parse(await fs.readFile(storePath, "utf-8")) as Record<
    string,
    SessionEntry
  >;
  return persisted[SESSION_KEY]?.origin;
}

async function seedExistingSession(storePath: string) {
  await writeSessionStore(storePath, {
    [SESSION_KEY]: {
      sessionId: "sess-1",
      updatedAt: Date.now(),
      origin: ORIGINAL_ORIGIN,
      deliveryContext: {
        channel: "webchat",
        to: "webchat:user-1",
      },
      lastChannel: "webchat",
      lastTo: "webchat:user-1",
    },
  });
}

describe("initSessionState origin preservation", () => {
  for (const provider of ["heartbeat", "cron-event", "exec-event"] as const) {
    it(`preserves existing origin for ${provider} turns in an existing session`, async () => {
      const storePath = await makeStorePath(`${provider}-origin-`);
      await seedExistingSession(storePath);

      const result = await initSessionState({
        ctx: buildSyntheticCtx(provider),
        cfg: buildConfig(storePath),
        commandAuthorized: true,
      });

      expect(result.sessionKey).toBe(SESSION_KEY);
      expect(result.sessionEntry.origin).toEqual(ORIGINAL_ORIGIN);
      expect(await readPersistedOrigin(storePath)).toEqual(ORIGINAL_ORIGIN);
    });
  }

  it("still updates origin for normal non-system providers", async () => {
    const storePath = await makeStorePath("webchat-origin-");
    await seedExistingSession(storePath);

    const result = await initSessionState({
      ctx: {
        Body: "hello",
        SessionKey: SESSION_KEY,
        Provider: "webchat",
        Surface: "webchat",
        ChatType: "direct",
        From: "webchat:user-2",
        To: "webchat:user-2",
        OriginatingChannel: "webchat",
        OriginatingTo: "webchat:user-2",
        SenderName: "Renamed User",
      },
      cfg: buildConfig(storePath),
      commandAuthorized: true,
    });

    expect(result.sessionEntry.origin).toEqual({
      ...ORIGINAL_ORIGIN,
      label: "Renamed User",
      from: "webchat:user-2",
      to: "webchat:user-2",
    });
    expect(await readPersistedOrigin(storePath)).toEqual({
      ...ORIGINAL_ORIGIN,
      label: "Renamed User",
      from: "webchat:user-2",
      to: "webchat:user-2",
    });
  });

  it("still creates origin metadata for brand-new heartbeat sessions", async () => {
    const storePath = await makeStorePath("new-heartbeat-origin-");

    const result = await initSessionState({
      ctx: buildSyntheticCtx("heartbeat"),
      cfg: buildConfig(storePath),
      commandAuthorized: true,
    });

    expect(result.sessionEntry.origin).toEqual({
      label: "heartbeat",
      provider: "webchat",
      surface: "webchat",
      chatType: "direct",
      from: "heartbeat",
      to: "webchat:user-1",
    });
    expect(await readPersistedOrigin(storePath)).toEqual({
      label: "heartbeat",
      provider: "webchat",
      surface: "webchat",
      chatType: "direct",
      from: "heartbeat",
      to: "webchat:user-1",
    });
  });
});
