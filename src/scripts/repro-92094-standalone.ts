#!/usr/bin/env node
// Issue #92094 — Real behavior proof
//
// This standalone script demonstrates the bug and its fix without vitest.
// Run it in two phases:
//   Phase 1: WITHOUT the fix  (comment out both reset calls in resetPluginRuntimeStateForTest)
//   Phase 2: WITH the fix      (both reset calls present, as they are now)
//
// What it proves:
//   When resetPluginRuntimeStateForTest() clears the active registry to null,
//   the module-level registeredChannelPluginLookup cache STILL holds stale
//   channel entries from a previous test — causing test bleed.
//
//   The fix clears both:
//     1. activePluginChannelRegistrySnapshot  (in runtime-channel-state.ts)
//     2. registeredChannelPluginLookup        (in registry-lookup.ts)
//
//   Without fix 1: the snapshot cache returns stale registry data
//   Without fix 2: the lookup cache returns stale channel entries

import { normalizeAnyChannelId } from "../channels/registry.ts";
import { setActivePluginRegistry } from "../plugins/runtime.ts";
import { resetPluginRuntimeStateForTest } from "../plugins/runtime.ts";
import { createTestRegistry } from "../test-utils/channel-plugins.ts";

const PASS = "\u2705";
const FAIL = "\u274C";

let passed = 0;
let failed = 0;

function assert(cond: boolean, label: string) {
  if (cond) {
    console.log(`  ${PASS} ${label}`);
    passed++;
  } else {
    console.log(`  ${FAIL} ${label}`);
    failed++;
  }
}

console.log("\n════════════════════════════════════════════════════════════");
console.log("  Real Behavior Proof \u2014 Issue #92094");
console.log("  resetPluginRuntimeStateForTest must clear both snapshot and lookup caches");
console.log("════════════════════════════════════════════════════════════\n");

// ── Simulate Test A: register telegram + discord ────────────────────────────
console.log("Test A: register telegram + discord");
const testARegistry = createTestRegistry([
  { pluginId: "telegram", plugin: { id: "telegram", meta: { aliases: ["tg"] } }, source: "test" },
  { pluginId: "discord", plugin: { id: "discord", meta: { aliases: ["dc"] } }, source: "test" },
]);
setActivePluginRegistry(testARegistry);

const testATg = normalizeAnyChannelId("telegram");
const testADiscord = normalizeAnyChannelId("discord");
console.log("  normalizeAnyChannelId('telegram'):", testATg);
console.log("  normalizeAnyChannelId('discord'):", testADiscord);
assert(testATg === "telegram", "Test A: telegram resolves");
assert(testADiscord === "discord", "Test A: discord resolves");

// ── Simulate Test B: reset then check bleed ──────────────────────────────────
//
// resetPluginRuntimeStateForTest() does:
//   state.activeRegistry = null
//   state.activeVersion += 1
//   installSurfaceRegistry(state.channel, null, false)  -> channel.registry = null, version += 1
//   clearPluginHostRuntimeState()
//   clearPluginMetadataLifecycleCaches()
//   resetActivePluginChannelRegistrySnapshot()    // FIX 1: clears snapshot cache
//   resetRegisteredChannelPluginLookupCache()   // FIX 2: clears lookup cache
//
// WITHOUT the fixes:
//   - The snapshot cache (activePluginChannelRegistrySnapshot) still holds the
//     cached {registry, version} from Test A. When buildCachedLookup() calls
//     getActivePluginChannelRegistrySnapshotFromState(), it returns the stale
//     snapshot because:
//       cached.state === state   -> TRUE (same state object)
//       cached.version === 1000  -> TRUE (version was already incremented)
//
//   - The lookup cache (registeredChannelPluginLookup) still holds the
//     cached channel entries from Test A. It returns stale data.
//
// WITH the fixes:
//   Both caches are explicitly reset to undefined, so the next lookup
//   reads fresh state (null registry -> empty channel list).
//
console.log("\nTest B: resetPluginRuntimeStateForTest() then check");
resetPluginRuntimeStateForTest();

const testBTg = normalizeAnyChannelId("telegram");
const testBDiscord = normalizeAnyChannelId("discord");
const testBTgAlias = normalizeAnyChannelId("tg");
console.log("  normalizeAnyChannelId('telegram'):", testBTg);
console.log("  normalizeAnyChannelId('discord'):", testBDiscord);
console.log("  normalizeAnyChannelId('tg'):", testBTgAlias);

// These assertions PROVE the fix works: telegram/discord from Test A must not bleed into Test B
assert(testBTg === null, "Test B: 'telegram' is null (not stale from Test A)");
assert(testBDiscord === null, "Test B: 'discord' is null (not stale from Test A)");
assert(testBTgAlias === null, "Test B: 'tg' alias is null (not stale from Test A)");

// ── Simulate Test C: new registry with only slack ────────────────────────────
console.log("\nTest C: new registry with only slack");
const testCRegistry = createTestRegistry([
  { pluginId: "slack", plugin: { id: "slack", meta: { aliases: [] } }, source: "test" },
]);
setActivePluginRegistry(testCRegistry);

const testCSlack = normalizeAnyChannelId("slack");
const testCTg = normalizeAnyChannelId("telegram");
console.log("  normalizeAnyChannelId('slack'):", testCSlack);
console.log("  normalizeAnyChannelId('telegram'):", testCTg);
assert(testCSlack === "slack", "Test C: slack resolves correctly");
assert(testCTg === null, "Test C: telegram still null from reset");

// ── Summary ─────────────────────────────────────────────────────────────────
console.log("\n────────────────────────────────────────────────────────────");
console.log(`  Results: ${passed} passed, ${failed} failed`);
console.log("────────────────────────────────────────────────────────────\n");

if (failed > 0) {
  console.log("KEY FINDING:");
  console.log("");
  console.log("BEFORE fix: resetPluginRuntimeStateForTest() did NOT clear");
  console.log("  activePluginChannelRegistrySnapshot and/or registeredChannelPluginLookup.");
  console.log("  Channel entries from Test A bled into Test B and Test C.");
  console.log("");
  console.log("AFTER fix: resetPluginRuntimeStateForTest() calls:");
  console.log(
    "    resetActivePluginChannelRegistrySnapshot()   // clears runtime-channel-state.ts cache",
  );
  console.log("    resetRegisteredChannelPluginLookupCache()   // clears registry-lookup.ts cache");
  console.log("  All test isolation assertions pass.");
  console.log("");
  process.exit(1);
} else {
  console.log("All assertions passed — the fix is working correctly.\n");
  process.exit(0);
}
