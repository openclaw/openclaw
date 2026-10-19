import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resolveClientCredentialStorePath } from "../infra/client-credential-paths.js";
import { loadOrCreateDeviceIdentity } from "../infra/device-identity.js";
import { withEnvAsync } from "../test-utils/env.js";
import { acquireTestPortBlock } from "../test-utils/port-claims.js";
import { checkGatewayHealth } from "./doctor-gateway-health.js";

vi.mock("../../packages/terminal-core/src/note.js", () => ({ note: vi.fn() }));

const tempDirs = useAutoCleanupTempDirTracker((cleanup) => afterEach(cleanup));

it.each([false, true])(
  "does not mint an identity while diagnosing an unreachable Gateway (node identity: %s)",
  async (withNodeIdentity) => {
    const home = tempDirs.make("doctor-read-only-credentials-");
    const env = {
      HOME: home,
      OPENCLAW_STATE_DIR: home,
      OPENCLAW_CONFIG_PATH: path.join(home, "openclaw.json"),
    };
    const credentials = resolveClientCredentialStorePath(env);
    const readIdentities = () => {
      if (!fs.existsSync(credentials)) {
        return [];
      }
      const db = new DatabaseSync(credentials, { readOnly: true });
      try {
        return db.prepare("SELECT * FROM device_identities ORDER BY identity_key").all();
      } finally {
        db.close();
      }
    };
    const claim = await acquireTestPortBlock({ offsets: [0] });
    try {
      await withEnvAsync(env, async () => {
        if (withNodeIdentity) {
          loadOrCreateDeviceIdentity({ identityKey: "node" });
        }
        const before = readIdentities();
        const result = await checkGatewayHealth({
          cfg: { gateway: { mode: "local", port: claim.port } },
          timeoutMs: 1_000,
          runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
        });
        expect(result.healthOk).toBe(false);
        const after = readIdentities();
        expect(after.map((row) => row.identity_key)).toEqual(before.map((row) => row.identity_key));
        expect(after).toEqual(before);
        expect(fs.existsSync(credentials)).toBe(withNodeIdentity);
      });
    } finally {
      await claim.release();
    }
  },
);
