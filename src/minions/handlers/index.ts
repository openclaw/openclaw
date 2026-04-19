import type { MinionHandler } from "../types.js";
import { ACP_SPAWN_HANDLER_NAME, acpSpawnHandler } from "./acp-spawn.handler.js";
import { CLI_SPAWN_HANDLER_NAME, cliSpawnHandler } from "./cli-spawn.handler.js";
import { CRON_TICK_HANDLER_NAME, cronTickHandler } from "./cron-tick.handler.js";
import {
  SUBAGENT_SPAWN_HANDLER_NAME,
  subagentSpawnHandler,
} from "./subagent-spawn.handler.js";

export type HandlerEntry = {
  name: string;
  handler: MinionHandler;
};

/**
 * All built-in minion handlers, sorted alphabetically by name for
 * deterministic registration order (prompt-cache stability per AGENTS.md).
 */
export const BUILTIN_HANDLERS: readonly HandlerEntry[] = [
  { name: ACP_SPAWN_HANDLER_NAME, handler: acpSpawnHandler },
  { name: CLI_SPAWN_HANDLER_NAME, handler: cliSpawnHandler },
  { name: CRON_TICK_HANDLER_NAME, handler: cronTickHandler },
  { name: SUBAGENT_SPAWN_HANDLER_NAME, handler: subagentSpawnHandler },
];

export {
  ACP_SPAWN_HANDLER_NAME,
  CLI_SPAWN_HANDLER_NAME,
  CRON_TICK_HANDLER_NAME,
  SUBAGENT_SPAWN_HANDLER_NAME,
};
