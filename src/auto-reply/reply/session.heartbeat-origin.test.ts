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

describe("initSessionState heartbeat origin preservation", () => {
  it("preserves existing origin for heartbeat runs in an existing session", async () => {
    const storePath = await makeStorePath("heartbeat-origin-");
    const sessionKey = "agent:main:main";
    const originalOrigin = {
      label: "My App — Project: Dashboard",
      provider: "webchat",
      surface: "webchat",
      chatType: "direct",
      from: "webchat:user-1",
      to: "webchat:user-1",
    } as const;

    await writeSessionStore(storePath, {
      [sessionKey]: {
        sessionId: "sess-1",
        updatedAt: Date.now(),
        origin: originalOrigin,
        deliveryContext: {
          channel: "webchat",
          to: "webchat:user-1",
        },
        lastChannel: "webchat",
        lastTo: "webchat:user-1",
      },
    });

    const cfg = {
      session: { store: storePath },
    } as OpenClawConfig;

    const result = await initSessionState({
      ctx: {
        Body: "Read HEARTBEAT.md and check in.",
        SessionKey: sessionKey,
        Provider: "heartbeat",
        Surface: "webchat",
        ChatType: "direct",
        From: "heartbeat",
        To: "heartbeat",
        OriginatingChannel: "webchat",
        OriginatingTo: "webchat:user-1",
      },
      cfg,
      commandAuthorized: true,
    });

    expect(result.sessionKey).toBe(sessionKey);
    expect(result.sessionEntry.origin).toEqual(originalOrigin);

    const persisted = JSON.parse(await fs.readFile(storePath, "utf-8")) as Record<
      string,
      SessionEntry
    >;
    expect(persisted[sessionKey]?.origin).toEqual(originalOrigin);
  });
});
