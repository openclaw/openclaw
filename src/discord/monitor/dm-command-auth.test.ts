import { describe, expect, it } from "vitest";
import { resolveDiscordDmCommandAccess } from "./dm-command-auth.js";

describe("resolveDiscordDmCommandAccess", () => {
  const sender = {
    id: "123",
    name: "alice",
    tag: "alice#0001",
  };

  it("allows open DMs and keeps command auth enabled without allowlist entries", async () => {
    const result = await resolveDiscordDmCommandAccess({
      accountId: "default",
      dmPolicy: "open",
      configuredAllowFrom: [],
      sender,
      allowNameMatching: false,
      useAccessGroups: true,
      readStoreAllowFrom: async () => [],
    });

    expect(result.decision).toBe("allow");
    expect(result.commandAuthorized).toBe(true);
  });

  it("marks command auth true when sender is allowlisted", async () => {
    const result = await resolveDiscordDmCommandAccess({
      accountId: "default",
      dmPolicy: "open",
      configuredAllowFrom: ["discord:123"],
      sender,
      allowNameMatching: false,
      useAccessGroups: true,
      readStoreAllowFrom: async () => [],
    });

    expect(result.decision).toBe("allow");
    expect(result.commandAuthorized).toBe(true);
  });

  it("keeps command auth enabled for open DMs when configured allowlist does not match", async () => {
    const result = await resolveDiscordDmCommandAccess({
      accountId: "default",
      dmPolicy: "open",
      configuredAllowFrom: ["discord:999"],
      sender,
      allowNameMatching: false,
      useAccessGroups: true,
      readStoreAllowFrom: async () => [],
    });

    expect(result.decision).toBe("allow");
    expect(result.allowMatch.allowed).toBe(false);
    expect(result.commandAuthorized).toBe(true);
  });

  it("returns pairing decision and unauthorized command auth for unknown senders", async () => {
    const result = await resolveDiscordDmCommandAccess({
      accountId: "default",
      dmPolicy: "pairing",
      configuredAllowFrom: ["discord:456"],
      sender,
      allowNameMatching: false,
      useAccessGroups: true,
      readStoreAllowFrom: async () => [],
    });

    expect(result.decision).toBe("pairing");
    expect(result.commandAuthorized).toBe(false);
  });

  it("authorizes sender from pairing-store allowlist entries", async () => {
    const result = await resolveDiscordDmCommandAccess({
      accountId: "default",
      dmPolicy: "pairing",
      configuredAllowFrom: [],
      sender,
      allowNameMatching: false,
      useAccessGroups: true,
      readStoreAllowFrom: async () => ["discord:123"],
    });

    expect(result.decision).toBe("allow");
    expect(result.commandAuthorized).toBe(true);
  });

  it("keeps open DM command auth true when access groups are disabled", async () => {
    const result = await resolveDiscordDmCommandAccess({
      accountId: "default",
      dmPolicy: "open",
      configuredAllowFrom: [],
      sender,
      allowNameMatching: false,
      useAccessGroups: false,
      readStoreAllowFrom: async () => [],
    });

    expect(result.decision).toBe("allow");
    expect(result.commandAuthorized).toBe(true);
  });

  it("rejects sender whose display name matches owner but has different snowflake ID", async () => {
    // Owner "alice" has snowflake ID "456". An attacker changes their Discord
    // display name to "alice" but has snowflake ID "123" — must be rejected.
    const attacker = { id: "123", name: "alice", tag: "alice" };
    const result = await resolveDiscordDmCommandAccess({
      accountId: "default",
      dmPolicy: "pairing",
      configuredAllowFrom: ["discord:456"],
      sender: attacker,
      allowNameMatching: false,
      useAccessGroups: true,
      readStoreAllowFrom: async () => [],
    });

    expect(result.decision).toBe("pairing");
    expect(result.commandAuthorized).toBe(false);
  });

  it("rejects name-only allowlist entries when allowNameMatching is disabled", async () => {
    // Config has a username "alice" in allowFrom (no numeric ID).
    // A sender whose username is "alice" but has a different ID must be
    // rejected when dangerouslyAllowNameMatching is false.
    const spoofingSender = { id: "999", name: "alice", tag: "alice" };
    const result = await resolveDiscordDmCommandAccess({
      accountId: "default",
      dmPolicy: "pairing",
      configuredAllowFrom: ["alice"],
      sender: spoofingSender,
      allowNameMatching: false,
      useAccessGroups: true,
      readStoreAllowFrom: async () => [],
    });

    expect(result.decision).toBe("pairing");
    expect(result.commandAuthorized).toBe(false);
    expect(result.allowMatch.allowed).toBe(false);
  });

  it("allows name-matching only when dangerouslyAllowNameMatching is true", async () => {
    const spoofingSender = { id: "999", name: "alice", tag: "alice" };
    const result = await resolveDiscordDmCommandAccess({
      accountId: "default",
      dmPolicy: "pairing",
      configuredAllowFrom: ["alice"],
      sender: spoofingSender,
      allowNameMatching: true,
      useAccessGroups: true,
      readStoreAllowFrom: async () => [],
    });

    expect(result.decision).toBe("allow");
    expect(result.commandAuthorized).toBe(true);
    expect(result.allowMatch.allowed).toBe(true);
  });
});
