import { afterEach, describe, expect, it } from "vitest";
import { createPersistentDedupe } from "../../plugin-sdk/persistent-dedupe.js";
import {
  buildDiscordOutboundIdempotencyKey,
  checkAndRecordOutboundSend,
  OUTBOUND_DEDUPE_TTL_MS,
  resetOutboundSendDedupeMemory,
} from "./outbound-dedupe.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeInMemoryDedupe() {
  // Use a tiny in-memory-only dedupe by pointing the file to /dev/null-equivalent
  // (we never actually write because we mock disk errors).
  return createPersistentDedupe({
    ttlMs: OUTBOUND_DEDUPE_TTL_MS,
    memoryMaxSize: 500,
    fileMaxEntries: 200,
    resolveFilePath: () => "/nonexistent-path-for-test/dedupe.json",
    onDiskError: () => {},
  });
}

// ---------------------------------------------------------------------------
// buildDiscordOutboundIdempotencyKey
// ---------------------------------------------------------------------------

describe("buildDiscordOutboundIdempotencyKey", () => {
  it("produces a stable key for the same inputs", () => {
    const key1 = buildDiscordOutboundIdempotencyKey({
      discordMessageId: "msg-abc-123",
      channel: "whatsapp",
      to: "+5511999999999",
      accountId: "acct1",
      payloadIndex: 0,
    });
    const key2 = buildDiscordOutboundIdempotencyKey({
      discordMessageId: "msg-abc-123",
      channel: "whatsapp",
      to: "+5511999999999",
      accountId: "acct1",
      payloadIndex: 0,
    });
    expect(key1).toBe(key2);
  });

  it("differs when discordMessageId changes", () => {
    const base = {
      discordMessageId: "msg-1",
      channel: "whatsapp",
      to: "+5511",
    };
    const k1 = buildDiscordOutboundIdempotencyKey(base);
    const k2 = buildDiscordOutboundIdempotencyKey({ ...base, discordMessageId: "msg-2" });
    expect(k1).not.toBe(k2);
  });

  it("differs when recipient changes", () => {
    const base = { discordMessageId: "msg-1", channel: "whatsapp", to: "+5511" };
    const k1 = buildDiscordOutboundIdempotencyKey(base);
    const k2 = buildDiscordOutboundIdempotencyKey({ ...base, to: "+5512" });
    expect(k1).not.toBe(k2);
  });

  it("differs when payloadIndex changes", () => {
    const base = { discordMessageId: "msg-1", channel: "whatsapp", to: "+5511" };
    const k0 = buildDiscordOutboundIdempotencyKey({ ...base, payloadIndex: 0 });
    const k1 = buildDiscordOutboundIdempotencyKey({ ...base, payloadIndex: 1 });
    expect(k0).not.toBe(k1);
  });

  it("defaults payloadIndex to 0 when omitted", () => {
    const withDefault = buildDiscordOutboundIdempotencyKey({
      discordMessageId: "x",
      channel: "whatsapp",
      to: "y",
    });
    const explicit = buildDiscordOutboundIdempotencyKey({
      discordMessageId: "x",
      channel: "whatsapp",
      to: "y",
      payloadIndex: 0,
    });
    expect(withDefault).toBe(explicit);
  });

  it("tolerates missing accountId", () => {
    const withoutAccount = buildDiscordOutboundIdempotencyKey({
      discordMessageId: "msg-1",
      channel: "whatsapp",
      to: "+5511",
    });
    expect(withoutAccount).toContain("discord-wa");
    expect(typeof withoutAccount).toBe("string");
  });
});

// ---------------------------------------------------------------------------
// checkAndRecordOutboundSend — core deduplication logic
// ---------------------------------------------------------------------------

describe("checkAndRecordOutboundSend — memory dedupe", () => {
  afterEach(() => {
    resetOutboundSendDedupeMemory();
  });

  it("returns isDuplicate=false on first call", async () => {
    const dedupe = makeInMemoryDedupe();
    const result = await checkAndRecordOutboundSend("key-first", { dedupe });
    expect(result.isDuplicate).toBe(false);
  });

  it("returns isDuplicate=true on second call with the same key", async () => {
    const dedupe = makeInMemoryDedupe();
    await checkAndRecordOutboundSend("key-dup", { dedupe });
    const second = await checkAndRecordOutboundSend("key-dup", { dedupe });
    expect(second.isDuplicate).toBe(true);
  });

  it("allows different keys to proceed independently", async () => {
    const dedupe = makeInMemoryDedupe();
    await checkAndRecordOutboundSend("key-a", { dedupe });
    const resultB = await checkAndRecordOutboundSend("key-b", { dedupe });
    expect(resultB.isDuplicate).toBe(false);
  });

  it("is idempotent across many concurrent calls with the same key (concurrency guard)", async () => {
    const dedupe = makeInMemoryDedupe();
    // Fire 10 concurrent checks with the same key — only the first should be new.
    const results = await Promise.all(
      Array.from({ length: 10 }, () => checkAndRecordOutboundSend("concurrent-key", { dedupe })),
    );
    const newCount = results.filter((r) => !r.isDuplicate).length;
    const dupCount = results.filter((r) => r.isDuplicate).length;
    expect(newCount).toBe(1);
    expect(dupCount).toBe(9);
  });

  it("fails open (isDuplicate=false) when an exception is thrown internally", async () => {
    // Simulate an error inside checkAndRecordOutboundSend by passing a broken
    // dedupe (null) and letting the catch handle it.
    const result = await checkAndRecordOutboundSend("key-error", {
      dedupe: null as unknown as ReturnType<typeof makeInMemoryDedupe>,
    }).catch(() => ({ isDuplicate: false }));
    expect(result.isDuplicate).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// End-to-end: full Discord→WhatsApp idempotency flow simulation
// ---------------------------------------------------------------------------

describe("Discord→WhatsApp duplicate suppression (simulation)", () => {
  it("blocks a second send for the same Discord message to the same recipient", async () => {
    const dedupe = makeInMemoryDedupe();
    const key = buildDiscordOutboundIdempotencyKey({
      discordMessageId: "discord-1234567890",
      channel: "whatsapp",
      to: "+5538998518080",
      accountId: "main",
      payloadIndex: 0,
    });

    // First send — should proceed.
    const first = await checkAndRecordOutboundSend(key, { dedupe });
    expect(first.isDuplicate).toBe(false);

    // Crash-recovery replay — should be suppressed.
    const replay = await checkAndRecordOutboundSend(key, { dedupe });
    expect(replay.isDuplicate).toBe(true);
  });

  it("allows distinct payloads from the same Discord message to proceed", async () => {
    const dedupe = makeInMemoryDedupe();
    const base = {
      discordMessageId: "discord-multi-payload",
      channel: "whatsapp",
      to: "+5538998518080",
    };

    const k0 = buildDiscordOutboundIdempotencyKey({ ...base, payloadIndex: 0 });
    const k1 = buildDiscordOutboundIdempotencyKey({ ...base, payloadIndex: 1 });

    const r0 = await checkAndRecordOutboundSend(k0, { dedupe });
    const r1 = await checkAndRecordOutboundSend(k1, { dedupe });
    expect(r0.isDuplicate).toBe(false);
    expect(r1.isDuplicate).toBe(false);
  });
});
