#!/usr/bin/env node

// Test script for Discord user resolution
import { loadConfig } from "./src/config/config.ts";
import { resolveDiscordAccount } from "./src/discord/accounts.ts";
import { resolveDiscordUserAllowlist } from "./src/discord/resolve-users.ts";

async function testResolveUser() {
  console.log("Loading config...");
  const cfg = loadConfig();

  console.log("Resolving Discord account...");
  const account = resolveDiscordAccount({ cfg });

  if (!account.token) {
    console.error("❌ No Discord token found in config");
    console.log("Set it with: openclaw configure discord");
    process.exit(1);
  }

  console.log("✓ Discord token found");

  const testUser = process.argv[2] || "ahsan";
  console.log(`\n🔍 Resolving user: "${testUser}"\n`);

  try {
    const results = await resolveDiscordUserAllowlist({
      token: account.token,
      entries: [testUser],
    });

    console.log("Results:");
    console.log(JSON.stringify(results, null, 2));

    const resolved = results.find((r) => r.resolved);
    if (resolved) {
      console.log(`\n✅ SUCCESS! Found user:`);
      console.log(`   ID: ${resolved.id}`);
      console.log(`   Name: ${resolved.name}`);
      console.log(`   Guild: ${resolved.guildName || "N/A"} (${resolved.guildId || "N/A"})`);
      if (resolved.note) {
        console.log(`   Note: ${resolved.note}`);
      }
    } else {
      console.log(`\n❌ User "${testUser}" not found`);
    }
  } catch (error: unknown) {
    console.error(`\n❌ Error: ${error instanceof Error ? error.message : String(error)}`);
    if (error instanceof Error) {
      console.error(error.stack);
    }
  }
}

testResolveUser().catch(console.error);
