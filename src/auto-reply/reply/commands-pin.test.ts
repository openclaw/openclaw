import { describe, expect, it } from "vitest";
import type { SessionEntry } from "../../config/sessions/types.js";
import { resolveEchoTargets } from "../../infra/outbound/echo.js";
import type { HandleCommandsParams } from "./commands-types.js";
import { baseCommandTestConfig, buildCommandTestParams } from "./commands.test-harness.js";
import { handlePinCommand } from "./commands-pin.js";

// A session entry whose last* fields identify the thread that most recently
// drove the session — i.e. the thread issuing the command. These are the exact
// fields the echo fan-out uses as the turn ORIGIN, so a correct pin must store
// them verbatim.
function entryFromThread(): SessionEntry {
  return {
    sessionId: "s1",
    updatedAt: Date.now(),
    lastChannel: "telegram",
    lastTo: "12345",
    lastAccountId: "default",
    lastThreadId: "77",
  } as unknown as SessionEntry;
}

function buildParams(commandBody: string): HandleCommandsParams {
  const params = buildCommandTestParams(commandBody, baseCommandTestConfig);
  const entry = entryFromThread();
  // No storePath → persistSessionEntry mutates the in-memory store only (no disk).
  params.sessionStore = { [params.sessionKey]: entry };
  params.sessionEntry = entry;
  return params;
}

describe("handlePinCommand", () => {
  it("ignores /pin when text commands are disabled", async () => {
    expect(await handlePinCommand(buildParams("/pin on"), false)).toBeNull();
  });

  it("ignores /pin from unauthorized senders", async () => {
    const params = buildParams("/pin on");
    params.command.isAuthorizedSender = false;
    expect(await handlePinCommand(params, true)).toEqual({ shouldContinue: false });
    expect(params.sessionStore?.[params.sessionKey]?.echoTargets).toBeUndefined();
  });

  it("/pin status reports unpinned by default", async () => {
    const result = await handlePinCommand(buildParams("/pin"), true);
    expect(result?.shouldContinue).toBe(false);
    expect(result?.reply?.text).toContain("not pinned");
  });

  it("/pin on stores the caller's origin identity verbatim (so self-exclusion matches)", async () => {
    const params = buildParams("/pin on");
    const result = await handlePinCommand(params, true);
    expect(result?.reply?.text).toContain("Pinned");
    const targets = params.sessionStore?.[params.sessionKey]?.echoTargets;
    expect(targets).toHaveLength(1);
    // The pinned target must equal the entry's last* (the origin the fan-out
    // excludes against), or this thread would mirror its own turns / siblings
    // would be wrongly excluded.
    expect(targets?.[0]).toMatchObject({
      channel: "telegram",
      to: "12345",
      accountId: "default",
      threadId: "77",
    });
  });

  it("/pin on twice is idempotent", async () => {
    const params = buildParams("/pin on");
    await handlePinCommand(params, true);
    const second = await handlePinCommand(params, true);
    expect(second?.reply?.text).toContain("Already pinned");
    expect(params.sessionStore?.[params.sessionKey]?.echoTargets).toHaveLength(1);
  });

  it("/pin off removes the pin", async () => {
    const params = buildParams("/pin on");
    await handlePinCommand(params, true);
    const off = await handlePinCommand({ ...params, command: { ...params.command, commandBodyNormalized: "/pin off", rawBodyNormalized: "/pin off" } }, true);
    expect(off?.reply?.text).toContain("Unpinned");
    expect(params.sessionStore?.[params.sessionKey]?.echoTargets).toBeUndefined();
  });

  it("/mirror is an alias for /pin", async () => {
    const params = buildParams("/mirror on");
    const result = await handlePinCommand(params, true);
    expect(result?.reply?.text).toContain("Pinned");
    expect(params.sessionStore?.[params.sessionKey]?.echoTargets).toHaveLength(1);
  });

  // End-to-end behavior proof: chain /pin's stored target through the REAL echo
  // fan-out resolver. This is the whole pin-from-here claim — a pinned thread
  // receives a SIBLING thread's turn but is excluded from its OWN turn — proven
  // through production code, not a hand-built target.
  it("pinned thread receives a sibling's turn and is excluded from its own", async () => {
    const params = buildParams("/pin on");
    await handlePinCommand(params, true);
    const entry = params.sessionStore?.[params.sessionKey] as SessionEntry;

    // A SIBLING thread of the same session drives a turn (different threadId on
    // the same channel). The pinned thread (77) must receive the mirror.
    const fromSibling = resolveEchoTargets(entry, {
      originChannel: "telegram",
      originTo: "12345",
      originAccountId: "default",
      originThreadId: "88",
      role: "assistant",
    });
    expect(fromSibling).toHaveLength(1);
    expect(fromSibling[0]).toMatchObject({ channel: "telegram", threadId: "77" });

    // The pinned thread itself drives a turn (origin === the pinned identity).
    // It must NOT mirror to itself.
    const fromSelf = resolveEchoTargets(entry, {
      originChannel: "telegram",
      originTo: "12345",
      originAccountId: "default",
      originThreadId: "77",
      role: "assistant",
    });
    expect(fromSelf).toHaveLength(0);
  });
});
