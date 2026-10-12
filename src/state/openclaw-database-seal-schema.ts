import { createHash } from "node:crypto";
import { VERSION, resolveRuntimeServiceBuildId, resolveRuntimeServiceCommit } from "../version.js";
import { OPENCLAW_AGENT_SCHEMA_SQL } from "./openclaw-agent-schema.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "./openclaw-state-schema.js";

// Include the definitions, not just user_version: development builds can change
// canonical shapes without changing their migration number.
export const OPENCLAW_DATABASE_SEAL_SCHEMA = createHash("sha256")
  .update(VERSION)
  .update(resolveRuntimeServiceBuildId() ?? resolveRuntimeServiceCommit() ?? "source")
  .update(OPENCLAW_AGENT_SCHEMA_SQL)
  .update(OPENCLAW_STATE_SCHEMA_SQL)
  .digest("hex");
