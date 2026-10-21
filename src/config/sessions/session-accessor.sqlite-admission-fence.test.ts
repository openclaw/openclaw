import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeEach, expect, it } from "vitest";
import { useSessionStoreTempDirs } from "../../test-utils/session-state-cleanup.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../runtime-snapshot.js";
import {
  appendTranscriptEvent,
  persistSessionTranscriptTurn,
  readActiveTranscriptEntryAnchor,
} from "./session-accessor.js";
import {
  everySessionTranscriptUserInputFrom,
  readSessionTranscriptMessageEvents,
} from "./session-accessor.sqlite-active-events.js";
import { runWithSessionTranscriptReadFence } from "./session-transcript-read-fence.js";
import { transcriptMessage } from "./transcript-message.test-support.js";

const tempDirs = useSessionStoreTempDirs(
  (cleanup) =>
    afterAll(async () => {
      await cleanup();
      clearRuntimeConfigSnapshot();
    }),
  "openclaw-admission-fence-",
);
let scope: {
  agentId: string;
  env: NodeJS.ProcessEnv;
  sessionId: string;
  sessionKey: string;
};
beforeEach(() => {
  scope = {
    agentId: "main",
    env: { ...process.env, OPENCLAW_STATE_DIR: tempDirs.make() },
    sessionId: "admission-fence-test",
    sessionKey: "agent:main:admission-fence-test",
  };
  setRuntimeConfigSnapshot({});
});

const userMessage = (id: string, parentId: string | null, content = id) =>
  transcriptMessage(id, parentId, { role: "user", content, idempotencyKey: `${id}:user` });
const persist = (...messages: ReturnType<typeof transcriptMessage>[]) =>
  persistSessionTranscriptTurn(scope, { messages, touchSessionEntry: false });
const reset = (id: string, parentId: string, firstKeptEntryId?: string) =>
  appendTranscriptEvent(scope, {
    type: "reset",
    id,
    parentId,
    timestamp: "2026-09-14T00:00:00.000Z",
    reason: "new",
    ...(firstKeptEntryId === undefined ? {} : { firstKeptEntryId }),
  });
const admission = (logicalTurnId = "fenced") => {
  const anchor = readActiveTranscriptEntryAnchor({ ...scope, entryId: "admitted" });
  if (!anchor) {
    throw new Error("missing real admission anchor");
  }
  return { ...anchor, logicalTurnId, role: "user" as const };
};
const accept = () => everySessionTranscriptUserInputFrom(scope, "source:user", () => true);

it("rejects a retained completion source reset before admission", async () => {
  await persist(userMessage("source", null, "completed child"));
  expect(accept()).toBe(true);
  await reset("before-admission-reset", "source", "source");
  await persist(userMessage("admitted", "before-admission-reset"));
  expect(
    readSessionTranscriptMessageEvents(scope).some(
      ({ event }) =>
        typeof event === "object" && event !== null && "id" in event && event.id === "source",
    ),
  ).toBe(true);
  expect(accept()).toBe(false);
  expect(runWithSessionTranscriptReadFence(admission("recovery"), accept)).toBe(false);
});

it("accepts an admission store path that aliases the same database", async () => {
  await persist(userMessage("source", null), userMessage("admitted", "source"));
  const anchor = admission("aliased-store");
  const aliasDir = path.join(path.dirname(path.dirname(anchor.storePath)), "agent-alias");
  fs.symlinkSync(
    path.dirname(anchor.storePath),
    aliasDir,
    process.platform === "win32" ? "junction" : "dir",
  );

  expect(
    runWithSessionTranscriptReadFence(
      {
        ...anchor,
        storePath: path.join(aliasDir, path.basename(anchor.storePath)),
      },
      accept,
    ),
  ).toBe(true);
});

it.each([false, true])(
  "keeps pre-fence control facts through a later reset (human=%s)",
  async (human) => {
    await persist(
      userMessage("source", null, "result"),
      ...(human ? [userMessage("human", "source", "new work")] : []),
      userMessage("admitted", human ? "human" : "source"),
    );
    const anchor = admission();
    await reset("later-reset", "admitted");
    await persist(
      transcriptMessage("after-reset", "later-reset", { role: "user", content: "fresh" }),
    );
    expect(accept()).toBe(false);
    const seen: unknown[] = [];
    const result = runWithSessionTranscriptReadFence(anchor, () =>
      everySessionTranscriptUserInputFrom(scope, "source:user", (message) => {
        seen.push(message);
        return (message as { idempotencyKey?: string }).idempotencyKey !== "human:user";
      }),
    );
    expect(result).toBe(!human);
    expect(seen.map((message) => (message as { idempotencyKey?: string }).idempotencyKey)).toEqual(
      human ? ["source:user", "human:user"] : ["source:user"],
    );
  },
);
