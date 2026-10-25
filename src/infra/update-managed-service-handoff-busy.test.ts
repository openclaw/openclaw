import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import "../test-utils/prepare-compiled-subprocesses.js";
import {
  createManagedHandoffTestBinding,
  assertManagedHandoffTestConsumer,
} from "../../test/helpers/managed-handoff-isolation.js";
import {
  installPrivateUpdateHandoffStore,
  writePrivateUpdateHandoffChildGuard,
} from "../../test/helpers/private-update-handoff-store.js";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resolveTestNodeExecPath } from "../test-utils/node-process.js";
import { activeManagedServiceUpdateHandoffs } from "./update-managed-service-handoff-current.js";
import { prepareManagedHandoffLeaseDatabaseIdentity } from "./update-managed-service-handoff-database.js";
import { createManagedHandoffLeaseStore } from "./update-managed-service-handoff-lease.js";
import { startManagedServiceUpdateHandoff } from "./update-managed-service-handoff.js";

const dirs = createTempDirTracker();
afterEach(async () => {
  for (const owner of activeManagedServiceUpdateHandoffs.values()) {
    await owner.closed;
  }
  activeManagedServiceUpdateHandoffs.clear();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  dirs.cleanup();
});

it.each([false, true])(
  "reports the actual lease instead of claiming an update is running (cancelled=%s)",
  async (cancelled) => {
    const root = fs.realpathSync(dirs.make("handoff-busy-"));
    const install = path.join(root, "install");
    const temporary = path.join(root, "tmp");
    const state = path.join(root, "state");
    for (const directory of [install, temporary, state]) {
      fs.mkdirSync(directory, { mode: 0o700 });
    }
    for (const [key, value] of Object.entries({
      OPENCLAW_PROFILE: "custody-fixture",
      HOME: root,
      USERPROFILE: root,
      TMPDIR: temporary,
      OPENCLAW_STATE_DIR: state,
      OPENCLAW_CONFIG_PATH: path.join(state, "openclaw.json"),
    })) {
      vi.stubEnv(key, value);
    }
    const { databasePath } = installPrivateUpdateHandoffStore(temporary);
    const store = createManagedHandoffLeaseStore({
      databasePath,
      existingIdentity: await prepareManagedHandoffLeaseDatabaseIdentity(databasePath),
      serviceManagerEnv: process.env,
      originalUpdateKey: install,
    });
    let holderPid = process.pid;
    if (cancelled) {
      const binding = createManagedHandoffTestBinding(temporary);
      const childEnv = writePrivateUpdateHandoffChildGuard(databasePath, temporary)(process.env);
      const source = `
        import { prepareManagedHandoffLeaseDatabaseIdentity } from ${JSON.stringify(new URL("./update-managed-service-handoff-database.ts", import.meta.url).href)};
        import { createManagedHandoffLeaseStore, resolveManagedUpdateLeaseDatabasePath } from ${JSON.stringify(new URL("./update-managed-service-handoff-lease.ts", import.meta.url).href)};
        if (resolveManagedUpdateLeaseDatabasePath() !== ${JSON.stringify(databasePath)}) throw new Error("Private handoff binding changed");
        const store = createManagedHandoffLeaseStore({ databasePath: ${JSON.stringify(databasePath)}, existingIdentity: await prepareManagedHandoffLeaseDatabaseIdentity(${JSON.stringify(databasePath)}), serviceManagerEnv: process.env, originalUpdateKey: ${JSON.stringify(install)} });
        const held = store.acquire(${JSON.stringify(install)}, "previous-update-owner", { kind: "update" });
        if (held.kind !== "acquired" || !store.cancelUpdate(held.lease)) throw new Error("Cancellation fixture failed");
      `;
      const child = spawnSync(
        resolveTestNodeExecPath(),
        ["--import", "tsx", binding.nodeOption, "--input-type=module", "--eval", source],
        {
          cwd: fileURLToPath(new URL("../../", import.meta.url)),
          env: childEnv,
          encoding: "utf8",
          timeout: 10000,
        },
      );
      expect([child.status, child.signal, child.error], child.stderr).toEqual([0, null, undefined]);
      holderPid = child.pid;
      assertManagedHandoffTestConsumer(binding, child.pid, path.resolve("src"));
    } else {
      assert(
        store.acquire(install, "previous-update-owner", { kind: "update" }).kind === "acquired",
      );
    }
    const before = store.read(install);
    const start = () =>
      startManagedServiceUpdateHandoff({
        root: install,
        restartDrainTimeoutMs: 1000,
        execPath: resolveTestNodeExecPath(),
        argv1: path.join(install, "openclaw.mjs"),
        env: process.env,
        meta: {},
      });
    // The first call exercises a real helper refusing durable custody; the second joins it.
    const results = await Promise.all([start(), start()]);
    for (const result of results) {
      expect(result).toMatchObject({
        status: "joined",
        handoffId: "previous-update-owner",
        message: expect.stringContaining("previous-update-owner"),
      });
      assert(result.status === "joined");
      expect(result.message).toContain(`helper PID ${holderPid} (${cancelled ? "dead" : "live"})`);
      expect(result.message).toContain(
        `executor PID ${holderPid} (${cancelled ? "dead" : "live"})`,
      );
      expect(result.message).toContain(cancelled ? "cancelled update custody" : "update lease");
      expect(result.message).toContain("openclaw --profile custody-fixture update repair");
      expect(result.message).toContain("openclaw --profile custody-fixture update status");
      expect(result.message).not.toContain("already running");
    }
    expect(store.read(install)).toEqual(before);
  },
);
