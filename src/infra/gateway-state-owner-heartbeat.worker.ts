import { parentPort, workerData } from "node:worker_threads";

void import("./gateway-state-owner-heartbeat.runtime.js").then(
  ({ runGatewayStateOwnerHeartbeat }) => {
    runGatewayStateOwnerHeartbeat(workerData, parentPort);
  },
);
