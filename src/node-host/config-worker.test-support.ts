import { once } from "node:events";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db.js";
import { configureNodeHost } from "./config.js";

const [candidateNodeId, nowMs] = process.argv.slice(2);
const start = once(process, "message");
process.send!("ready");
await start;

const config = await configureNodeHost({
  candidateNodeId,
  fallbackDisplayName: "node",
  gateway: {},
  nowMs: Number(nowMs),
});
await new Promise<void>((resolve, reject) => {
  process.send!(config, (error) => (error ? reject(error) : resolve()));
});
await closeOpenClawStateDatabaseAsync();
process.disconnect!();
