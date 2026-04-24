import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { clearAllowFromStoreReadCacheForTest } from "../pairing/allow-from-store-read.js";
import { resolveCommandAuthorization } from "./command-auth.js";
import type { MsgContext } from "./templating.js";
import { installDiscordRegistryHooks } from "./test-helpers/command-auth-registry-fixture.js";

installDiscordRegistryHooks();

// Paired-device entries from the per-channel, per-account pairing store
// should be merged into the provider allowFrom list that `command-auth.ts`
// uses to derive owner candidates. This makes paired senders `senderIsOwner
// = true` across every channel (telegram, slack, whatsapp, discord, ...)
// without each channel needing its own per-plugin wiring.
describe("command-auth pairing-store merge", () => {
  let tmpDir: string;
  let prevOAuthDir: string | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), "openclaw-pairing-test-"));
    mkdirSync(tmpDir, { recursive: true });
    prevOAuthDir = process.env.OPENCLAW_OAUTH_DIR;
    process.env.OPENCLAW_OAUTH_DIR = tmpDir;
    clearAllowFromStoreReadCacheForTest();
  });

  afterEach(() => {
    if (prevOAuthDir === undefined) {
      delete process.env.OPENCLAW_OAUTH_DIR;
    } else {
      process.env.OPENCLAW_OAUTH_DIR = prevOAuthDir;
    }
    clearAllowFromStoreReadCacheForTest();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function writePairingStore(channel: string, accountId: string, allowFrom: string[]) {
    const file = path.join(tmpDir, `${channel}-${accountId}-allowFrom.json`);
    writeFileSync(file, JSON.stringify({ version: 1, allowFrom }));
  }

  it("promotes paired DM senders to senderIsOwner=true", () => {
    writePairingStore("discord", "acct1", ["paired-user-123"]);

    const auth = resolveCommandAuthorization({
      ctx: {
        Provider: "discord",
        Surface: "discord",
        ChatType: "direct",
        AccountId: "acct1",
        From: "discord:paired-user-123",
        SenderId: "paired-user-123",
      } as MsgContext,
      cfg: { channels: { discord: {} } } as OpenClawConfig,
      commandAuthorized: true,
    });

    expect(auth.senderIsOwner).toBe(true);
    expect(auth.isAuthorizedSender).toBe(true);
  });

  it("does NOT promote unpaired senders", () => {
    writePairingStore("discord", "acct1", ["paired-user-123"]);

    const auth = resolveCommandAuthorization({
      ctx: {
        Provider: "discord",
        Surface: "discord",
        ChatType: "direct",
        AccountId: "acct1",
        From: "discord:someone-else",
        SenderId: "someone-else",
      } as MsgContext,
      cfg: { channels: { discord: {} } } as OpenClawConfig,
      commandAuthorized: true,
    });

    expect(auth.senderIsOwner).toBe(false);
  });

  it("preserves behavior when the pairing store is empty (no regression)", () => {
    // No pairing store file at all.
    const auth = resolveCommandAuthorization({
      ctx: {
        Provider: "discord",
        Surface: "discord",
        ChatType: "direct",
        AccountId: "acct1",
        From: "discord:123",
        SenderId: "123",
      } as MsgContext,
      cfg: { channels: { discord: {} } } as OpenClawConfig,
      commandAuthorized: true,
    });

    // Matches the behavior covered by command-auth.owner-default.test.ts:
    // no ownerAllowFrom, empty allowFrom → senderIsOwner=false.
    expect(auth.senderIsOwner).toBe(false);
  });

  it("merges pairing-store entries with config allowFrom (neither demotes the other)", () => {
    writePairingStore("discord", "acct1", ["paired-user-123"]);

    // Config-listed user should still be an owner candidate.
    const configAuth = resolveCommandAuthorization({
      ctx: {
        Provider: "discord",
        Surface: "discord",
        ChatType: "direct",
        AccountId: "acct1",
        From: "discord:config-user",
        SenderId: "config-user",
      } as MsgContext,
      cfg: {
        channels: { discord: { allowFrom: ["config-user"] } },
      } as OpenClawConfig,
      commandAuthorized: true,
    });
    expect(configAuth.senderIsOwner).toBe(true);

    // Paired user also still an owner candidate alongside config entries.
    const pairedAuth = resolveCommandAuthorization({
      ctx: {
        Provider: "discord",
        Surface: "discord",
        ChatType: "direct",
        AccountId: "acct1",
        From: "discord:paired-user-123",
        SenderId: "paired-user-123",
      } as MsgContext,
      cfg: {
        channels: { discord: { allowFrom: ["config-user"] } },
      } as OpenClawConfig,
      commandAuthorized: true,
    });
    expect(pairedAuth.senderIsOwner).toBe(true);
  });

  it("scopes pairing-store reads by accountId (acct2 store does not grant ownership in acct1)", () => {
    writePairingStore("discord", "acct2", ["paired-user-123"]);

    const auth = resolveCommandAuthorization({
      ctx: {
        Provider: "discord",
        Surface: "discord",
        ChatType: "direct",
        AccountId: "acct1",
        From: "discord:paired-user-123",
        SenderId: "paired-user-123",
      } as MsgContext,
      cfg: { channels: { discord: {} } } as OpenClawConfig,
      commandAuthorized: true,
    });

    expect(auth.senderIsOwner).toBe(false);
  });
});
