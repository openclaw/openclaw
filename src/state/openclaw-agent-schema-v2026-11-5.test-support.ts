import { readFileSync } from "node:fs";

// Frozen at the v2026.11.5 latest-stable release (schema version 38), captured
// from the tag's shipped openclaw-agent-schema.sql. Never derive migration
// input from its target. standing_intents is in its pre-location keywords-only
// form; the latest-stable upgrade test migrates this shape to the current
// schema and proves the additive location columns arrive without data loss.
export const OPENCLAW_AGENT_V2026_11_5_SQL = readFileSync(
  new URL("../../test/fixtures/sqlite/openclaw-agent-v2026.11.5.sql", import.meta.url),
  "utf8",
);
