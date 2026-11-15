import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  loadSessionEntry,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import { useSessionStoreTempDirs } from "../../test-utils/session-state-cleanup.js";
import { buildBuiltinChatCommands } from "../commands-registry.shared.js";
import { takeCommandSessionMetadataChanges } from "./command-session-metadata.js";
import { handleNameCommand } from "./commands-name.js";
import type { HandleCommandsParams } from "./commands-types.js";
import { buildCommandTestParams } from "./commands.test-harness.js";

const sessionKey = "agent:main:web:main";
const sessionDirs = useSessionStoreTempDirs(afterAll, "openclaw-name-command-");

let storePath: string;
beforeEach(() => {
  storePath = path.join(sessionDirs.make(), "sessions.json");
});

function session(overrides: Partial<SessionEntry> = {}): SessionEntry {
  return {
    sessionId: "sess-main",
    updatedAt: 1,
    totalTokens: 0,
    totalTokensFresh: true,
    ...overrides,
  };
}

async function seed(entry = session(), key = sessionKey) {
  await upsertSessionEntryCore({ storePath, sessionKey: key }, entry);
}

function buildNameParams(
  commandBodyNormalized: string,
  overrides: { isAuthorizedSender?: boolean; commandSource?: "native" | "text" } = {},
): HandleCommandsParams {
  const params = buildCommandTestParams(
    commandBodyNormalized,
    {},
    {
      Provider: "web",
      Surface: "web",
      CommandSource: overrides.commandSource ?? "text",
    },
  );
  Object.assign(params.command, {
    isAuthorizedSender: overrides.isAuthorizedSender ?? true,
  });
  return Object.assign(params, {
    sessionStore: {},
    sessionKey,
    storePath,
  });
}

describe("name command", () => {
  it("registers and loads the command on text and native surfaces", () => {
    const command = buildBuiltinChatCommands().find((entry) => entry.key === "name");

    expect(command).toMatchObject({
      nativeName: "name",
      textAliases: ["/name"],
      acceptsArgs: true,
      scope: "both",
      category: "session",
      args: [expect.objectContaining({ name: "title", captureRemaining: true })],
    });
  });

  it("suggests a name without mutating when no argument is given", async () => {
    await seed();

    const params = buildNameParams("/name");
    params.sessionEntry = loadSessionEntry({ storePath, sessionKey });
    expect(await handleNameCommand(params, true)).toMatchObject({
      shouldContinue: false,
      reply: { text: expect.stringContaining("Use /name <title>") },
    });
    expect(loadSessionEntry({ storePath, sessionKey })?.label).toBeUndefined();
    expect(takeCommandSessionMetadataChanges(params.ctx)).toBeUndefined();
  });

  it("rejects a label already used by another session", async () => {
    const now = Date.now();
    await seed(session({ updatedAt: now }));
    await seed(
      session({ sessionId: "sess-other", updatedAt: now, label: "Taken" }),
      "agent:main:web:other",
    );

    const params = buildNameParams("/name Taken");
    expect((await handleNameCommand(params, true))?.reply?.text).toContain("label already in use");
    expect(loadSessionEntry({ storePath, sessionKey })?.label).toBeUndefined();
    expect(takeCommandSessionMetadataChanges(params.ctx)).toBeUndefined();
  });

  it("reads the persisted name when params.sessionEntry is absent", async () => {
    await seed(session({ label: "Billing rework", displayName: "Dashboard session" }));

    const params = buildNameParams("/name");
    const result = await handleNameCommand(params, true);

    expect(result?.reply?.text).toContain("Current session name: Billing rework");
    expect(result?.reply?.text).toContain("Suggested name: Dashboard session");
  });

  it("seeds a brand-new native session entry that is not yet persisted", async () => {
    const params = buildNameParams("/name First native", { commandSource: "native" });
    params.sessionEntry = session({ sessionId: "sess-native" });

    expect(await handleNameCommand(params, true)).toMatchObject({
      shouldContinue: false,
      reply: { text: expect.stringContaining("First native") },
    });
    expect(loadSessionEntry({ storePath, sessionKey })?.label).toBe("First native");
    expect(params.sessionEntry?.label).toBe("First native");
    expect(takeCommandSessionMetadataChanges(params.ctx)).toEqual([
      { sessionKey, agentId: "main", reason: "command-metadata" },
    ]);
  });

  it("does not rename for an unauthorized sender", async () => {
    await seed();

    const params = buildNameParams("/name Secret", { isAuthorizedSender: false });
    expect((await handleNameCommand(params, true))?.shouldContinue).toBe(false);
    expect(loadSessionEntry({ storePath, sessionKey })?.label).toBeUndefined();
    expect(takeCommandSessionMetadataChanges(params.ctx)).toBeUndefined();
  });

  it("ignores other commands and disabled text commands", async () => {
    const params = buildNameParams("/name Anything");
    expect(await handleNameCommand(params, false)).toBeNull();
    expect(await handleNameCommand(buildNameParams("/goal status"), true)).toBeNull();
  });
});
