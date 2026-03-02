import { describe, expect, it, vi } from "vitest";
import type { DiscordDmCommandAccess } from "./dm-command-auth.js";
import { handleDiscordDmCommandDecision } from "./dm-command-decision.js";

function buildDmAccess(overrides: Partial<DiscordDmCommandAccess>): DiscordDmCommandAccess {
  return {
    decision: "allow",
    reason: "ok",
    commandAuthorized: true,
    allowMatch: { allowed: true, matchKey: "123", matchSource: "id" },
    ...overrides,
  };
}

describe("handleDiscordDmCommandDecision", () => {
  it("returns true for allowed DM access", async () => {
    const onPairingCreated = vi.fn(async () => {});
    const onUnauthorized = vi.fn(async () => {});
    const upsertPairingRequest = vi.fn(async () => ({ code: "PAIR-1", created: true }));

    const allowed = await handleDiscordDmCommandDecision({
      dmAccess: buildDmAccess({ decision: "allow" }),
      accountId: "default",
      sender: { id: "123", tag: "alice#0001", name: "alice" },
      onPairingCreated,
      onUnauthorized,
      upsertPairingRequest,
    });

    expect(allowed).toBe(true);
    expect(upsertPairingRequest).not.toHaveBeenCalled();
    expect(onPairingCreated).not.toHaveBeenCalled();
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it("creates pairing reply for new pairing requests", async () => {
    const onPairingCreated = vi.fn(async () => {});
    const onUnauthorized = vi.fn(async () => {});
    const upsertPairingRequest = vi.fn(async () => ({ code: "PAIR-1", created: true }));

    const allowed = await handleDiscordDmCommandDecision({
      dmAccess: buildDmAccess({
        decision: "pairing",
        commandAuthorized: false,
        allowMatch: { allowed: false },
      }),
      accountId: "default",
      sender: { id: "123", tag: "alice#0001", name: "alice" },
      onPairingCreated,
      onUnauthorized,
      upsertPairingRequest,
    });

    expect(allowed).toBe(false);
    expect(upsertPairingRequest).toHaveBeenCalledWith({
      channel: "discord",
      id: "123",
      accountId: "default",
      meta: {
        tag: "alice#0001",
        name: "alice",
      },
    });
    expect(onPairingCreated).toHaveBeenCalledWith("PAIR-1");
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it("skips pairing reply when pairing request already exists", async () => {
    const onPairingCreated = vi.fn(async () => {});
    const onUnauthorized = vi.fn(async () => {});
    const upsertPairingRequest = vi.fn(async () => ({ code: "PAIR-1", created: false }));

    const allowed = await handleDiscordDmCommandDecision({
      dmAccess: buildDmAccess({
        decision: "pairing",
        commandAuthorized: false,
        allowMatch: { allowed: false },
      }),
      accountId: "default",
      sender: { id: "123", tag: "alice#0001", name: "alice" },
      onPairingCreated,
      onUnauthorized,
      upsertPairingRequest,
    });

    expect(allowed).toBe(false);
    expect(onPairingCreated).not.toHaveBeenCalled();
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it("runs unauthorized handler for blocked DM access", async () => {
    const onPairingCreated = vi.fn(async () => {});
    const onUnauthorized = vi.fn(async () => {});
    const upsertPairingRequest = vi.fn(async () => ({ code: "PAIR-1", created: true }));

    const allowed = await handleDiscordDmCommandDecision({
      dmAccess: buildDmAccess({
        decision: "block",
        commandAuthorized: false,
        allowMatch: { allowed: false },
      }),
      accountId: "default",
      sender: { id: "123", tag: "alice#0001", name: "alice" },
      onPairingCreated,
      onUnauthorized,
      upsertPairingRequest,
    });

    expect(allowed).toBe(false);
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
    expect(upsertPairingRequest).not.toHaveBeenCalled();
    expect(onPairingCreated).not.toHaveBeenCalled();
  });
});
