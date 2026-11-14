import fs from "node:fs";
import path from "node:path";
import { afterEach, assert, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { readDatabasePathIdentitySync } from "../infra/sqlite-worker-identity.js";
import { createPermitPool } from "../shared/permit-pool.js";
import { prepareAgentDatabaseStartupVerification } from "./agent-database-startup-integrity.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);

it("verifies again when a completed verification is revoked, but shares unfinished attempts", async () => {
  const root = dirs.make("integrity-generation-");
  const pathname = path.join(root, "agent.sqlite");
  fs.writeFileSync(pathname, "synthetic physical identity; verification is controlled");
  const identity = readDatabasePathIdentitySync(pathname);
  assert(identity.birthtime !== undefined);
  const controller = new AbortController();
  const input = {
    agentId: "main",
    paths: [pathname],
    env: { OPENCLAW_STATE_DIR: root },
    signal: controller.signal,
  };
  const prepared = {
    agentId: input.agentId,
    path: pathname,
    env: input.env,
    identity: identity.key.slice("file:".length),
    birthtime: identity.birthtime,
  };
  const verifyIntegrity = vi.fn(async () => {});
  const activation = { isCurrent: () => true, verifyIntegrity };
  const permits = createPermitPool(1);
  const prepare = (integrityVerifiedAt?: number) =>
    prepareAgentDatabaseStartupVerification(input, activation, permits, {
      ...prepared,
      integrityVerifiedAt,
    })!;
  try {
    await prepare().verify();
    await prepare(123).verify();
    expect(verifyIntegrity).toHaveBeenCalledTimes(1);
    // A successor admission has lost the completed proof after an unclean native retirement.
    await prepare().verify();
    expect(verifyIntegrity).toHaveBeenCalledTimes(2);
    verifyIntegrity.mockRejectedValueOnce(new Error("synthetic interrupted verification"));
    await prepare().verify();
    await prepare().verify();
    expect(verifyIntegrity).toHaveBeenCalledTimes(3);
  } finally {
    controller.abort();
  }
});
