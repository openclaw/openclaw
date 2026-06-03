import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll } from "vitest";
import { startConnectedServerWithClient } from "./test-helpers.js";

type ConnectedGateway = Awaited<ReturnType<typeof startConnectedServerWithClient>>;

function requireValue<T>(value: T | undefined, label: string): T {
  if (value === undefined) {
    throw new Error(`${label} is not ready`);
  }
  return value;
}

export function installConnectedSessionStoreGatewaySuite(prefix: string) {
  let started: ConnectedGateway | undefined;
  let sessionStoreDir: string | undefined;
  let sessionStorePath: string | undefined;

  beforeAll(async () => {
    started = await startConnectedServerWithClient();
    sessionStoreDir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
    sessionStorePath = path.join(sessionStoreDir, "sessions.json");
  });

  afterAll(async () => {
    started?.ws.close();
    await started?.server.close();
    if (sessionStoreDir) {
      await fs.rm(sessionStoreDir, { recursive: true, force: true });
    }
  });

  return {
    get sessionStorePath() {
      return requireValue(sessionStorePath, "session store path");
    },
    get ws() {
      return requireValue(started, "gateway client").ws;
    },
  };
}
