import { requireNodeSqlite } from "./sqlite.js";

function detectNodeSqliteSupport(): boolean {
  try {
    requireNodeSqlite();
    return true;
  } catch {
    return false;
  }
}

export const HAS_NODE_SQLITE = detectNodeSqliteSupport();
