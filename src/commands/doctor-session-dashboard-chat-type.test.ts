import { afterEach, describe, expect, it, vi } from "vitest";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import {
  listSessionEntriesCore,
  replaceSessionEntry,
} from "../config/sessions/session-accessor.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
} from "../state/openclaw-agent-db.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";

const note = vi.hoisted(() => vi.fn());
vi.mock("../../packages/terminal-core/src/note.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../packages/terminal-core/src/note.js")>()),
  note,
}));

import { isUnstampedDashboardRoot } from "./doctor-session-dashboard-chat-type.js";
import { noteSessionTranscriptHealth } from "./doctor-session-transcripts.js";

const ROOT_KEY = "agent:main:dashboard:7d3c1f00-0000-4000-8000-000000000001";

// The durable shape v2026.10.6 wrote for a dashboard chat created without a message.
const legacyRoot = (overrides: Partial<SessionEntry> = {}): SessionEntry => ({
  sessionId: "legacy-root",
  updatedAt: 1,
  createdVia: "operator",
  createdAt: 1,
  spawnDepth: 0,
  parentSessionKey: "agent:main:main",
  ...overrides,
});

const discordDelivery: SessionEntry["delivery"] = {
  kind: "external",
  route: { channel: "discord", accountId: "default", target: { to: "channel:1" } },
  context: { channel: "discord", accountId: "default", to: "channel:1" },
  origin: { provider: "discord", accountId: "default", to: "channel:1", chatType: "channel" },
};

describe("isUnstampedDashboardRoot", () => {
  const cfg: OpenClawConfig = {};

  it("matches an operator dashboard root grouped under its agent main session", () => {
    expect(isUnstampedDashboardRoot(legacyRoot(), ROOT_KEY, cfg)).toBe(true);
  });

  it("uses the configured main key for the grouping parent", () => {
    const custom: OpenClawConfig = { session: { mainKey: "home" } };
    expect(isUnstampedDashboardRoot(legacyRoot(), ROOT_KEY, custom)).toBe(false);
    expect(
      isUnstampedDashboardRoot(
        legacyRoot({ parentSessionKey: "agent:main:home" }),
        ROOT_KEY,
        custom,
      ),
    ).toBe(true);
  });

  it.each<[string, Partial<SessionEntry>, string?]>([
    ["an existing chat type", { chatType: "group" }],
    ["a channel-created row", { createdVia: "channel" }],
    ["a spawn-created row", { createdVia: "spawn" }],
    ["a row without a creation stamp", { createdVia: undefined }],
    ["a spawned child", { spawnedBy: "agent:main:main" }],
    ["a fork", { forkSource: { sessionKey: ROOT_KEY, sessionId: "source" } }],
    ["a plugin-owned row", { pluginOwnerId: "workboard" }],
    ["an incognito row", { incognito: true }],
    ["an external delivery route", { delivery: discordDelivery }],
    ["an explicit child of another session", { parentSessionKey: "agent:main:discord:group:1" }],
    ["an unparented root", { parentSessionKey: undefined }],
    ["a channel-shaped key", {}, "agent:main:discord:group:123"],
    ["the agent main session", {}, "agent:main:main"],
    ["an incognito key", {}, "agent:main:dashboard:incognito-7d3c1f00"],
    ["another agent's main as parent", {}, "agent:ops:dashboard:7d3c1f00"],
  ])("rejects %s", (_name, overrides, key = ROOT_KEY) => {
    expect(isUnstampedDashboardRoot(legacyRoot(overrides), key, cfg)).toBe(false);
  });
});

describe("doctor dashboard chat type backfill", () => {
  let state: OpenClawTestState | undefined;

  afterEach(async () => {
    note.mockClear();
    await state?.cleanup();
    state = undefined;
  });

  it("records only eligible dashboard roots as direct, and only under --fix", async () => {
    state = await createOpenClawTestState({ prefix: "openclaw-doctor-dashboard-chat-type-" });
    const config: OpenClawConfig = { plugins: { enabled: false } };
    setRuntimeConfigSnapshot(config);
    const env = state.env;
    const rows: Record<string, SessionEntry> = {
      [ROOT_KEY]: legacyRoot(),
      "agent:main:discord:group:123": legacyRoot({ sessionId: "group", createdVia: "channel" }),
      "agent:main:dashboard:7d3c1f00-0000-4000-8000-000000000002": legacyRoot({
        sessionId: "plugin",
        pluginOwnerId: "workboard",
      }),
    };
    for (const [sessionKey, entry] of Object.entries(rows)) {
      await replaceSessionEntry({ agentId: "main", env, sessionKey }, entry);
    }
    const settle = async () => {
      await closeOpenClawAgentDatabasesAsync();
      closeOpenClawAgentDatabasesForTest();
    };
    const read = () =>
      Object.fromEntries(
        listSessionEntriesCore({ agentId: "main", env }).map((row) => [
          row.sessionKey,
          row.entry.chatType,
        ]),
      );

    await noteSessionTranscriptHealth({ cfg: config, env, shouldRepair: false });
    await settle();
    expect(read()[ROOT_KEY]).toBeUndefined();
    expect(note).toHaveBeenCalledWith(
      expect.stringContaining("Would record 1"),
      expect.any(String),
    );
    note.mockClear();

    await noteSessionTranscriptHealth({ cfg: config, env, shouldRepair: true });
    await settle();
    expect(read()).toEqual({
      [ROOT_KEY]: "direct",
      "agent:main:discord:group:123": undefined,
      "agent:main:dashboard:7d3c1f00-0000-4000-8000-000000000002": undefined,
    });
    const repaired = listSessionEntriesCore({ agentId: "main", env }).find(
      (row) => row.sessionKey === ROOT_KEY,
    )?.entry;
    // The stamp is the only change: the incarnation a linked job captured stays current.
    expect(repaired).toMatchObject({ ...legacyRoot(), chatType: "direct" });
    expect(note).toHaveBeenCalledWith(
      expect.stringContaining(`Recorded 1 dashboard chat(s)`),
      "Session chat type",
    );

    note.mockClear();
    await noteSessionTranscriptHealth({ cfg: config, env, shouldRepair: true });
    expect(note).not.toHaveBeenCalledWith(expect.anything(), "Session chat type");
  });
});
