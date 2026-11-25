import assert from "node:assert/strict";
import {
  acquireGatewayStateOwner,
  acquireStateDatabaseSchemaLease,
} from "../infra/gateway-state-owner.js";
import type { NativeWorkerResourcePort } from "../infra/worker-native-lifecycle.types.js";

export function createNativeWorkerResource(
  port: NativeWorkerResourcePort,
  input: { databasePath: string; kind: "schema" | "offline" },
) {
  assert.equal(typeof input.databasePath, "string");
  const owner =
    input.kind === "schema"
      ? acquireStateDatabaseSchemaLease(input.databasePath)
      : acquireGatewayStateOwner({ databasePath: input.databasePath });
  port.on("message", () => port.postMessage(process.pid));
  return {
    close() {
      owner.release();
      port.close();
    },
  };
}
