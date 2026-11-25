import crypto from "node:crypto";
import { once } from "node:events";
import { mock } from "node:test";
import { configureNodeHost } from "./config.js";

const [candidateNodeId, nowMs] = process.argv.slice(2);
const start = once(process, "message");
process.send!("ready");
await start;

mock.method(crypto, "randomUUID", () => candidateNodeId, { times: 1 });
mock.method(Date, "now", () => Number(nowMs), { times: 1 });
const config = await configureNodeHost({
  fallbackDisplayName: "node",
  gateway: {},
});
await new Promise<void>((resolve, reject) => {
  process.send!(config, (error) => (error ? reject(error) : resolve()));
});
process.disconnect!();
