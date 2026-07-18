import { SqliteBoardStore } from "../boards/sqlite-board-store.js";
import { getRuntimeConfig } from "../config/io.js";
import { resolveSessionStoreAgentId } from "./session-store-key.js";

export const boardStore = new SqliteBoardStore({
  resolveAgentId: (sessionKey) => resolveSessionStoreAgentId(getRuntimeConfig(), sessionKey),
});
