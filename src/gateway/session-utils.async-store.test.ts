import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  resolveGatewaySessionStoreTarget,
  resolveGatewaySessionStoreTargetAsync,
} from "./session-utils.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function createTempStore(entries: Record<string, unknown>) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-session-utils-"));
  tempRoots.push(dir);
  const storePath = path.join(dir, "sessions.json");
  await fs.writeFile(storePath, `${JSON.stringify(entries, null, 2)}\n`, "utf-8");
  return { dir, storePath };
}

test("async gateway session target resolution matches JSON sync legacy-key scanning", async () => {
  const { storePath } = await createTempStore({
    "agent:ops:CUSTOM": { sessionId: "sess-upper", updatedAt: 20 },
    "agent:ops:custom": { sessionId: "sess-lower", updatedAt: 10 },
  });
  const cfg = {
    session: { store: storePath },
    agents: { list: [{ id: "ops" }] },
  } satisfies OpenClawConfig;

  const syncTarget = resolveGatewaySessionStoreTarget({
    cfg,
    key: "agent:ops:custom",
  });
  const asyncTarget = await resolveGatewaySessionStoreTargetAsync({
    cfg,
    key: "agent:ops:custom",
  });

  expect(asyncTarget).toEqual(syncTarget);
  expect(asyncTarget.storePath).toBe(storePath);
  expect(asyncTarget.storeKeys).toEqual(
    expect.arrayContaining(["agent:ops:custom", "agent:ops:CUSTOM"]),
  );
});
