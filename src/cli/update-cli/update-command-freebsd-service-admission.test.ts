import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { onExit } from "signal-exit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { discoverFreeBsdService } from "../../../scripts/lib/freebsd-service-discovery.mjs";
import { isFreeBsdGatewayServiceAbsent } from "../../daemon/freebsd-service.js";
import * as service from "../../daemon/service.js";
import { CONTROL_PLANE_UPDATE_SENTINEL_META_ENV } from "../../infra/update-control-plane-sentinel.js";
import { nativeFreeBsd, withFreeBsdFixture } from "../../infra/update-freebsd.test-support.js";
import { withEnvAsync } from "../../test-utils/env.js";
import * as shared from "./shared.js";
import {
  prepareUpdateCommand,
  admitUpdateCommandRun,
  completeUpdateCommandRun,
} from "./update-command-run.js";

const disposableGuest =
  nativeFreeBsd &&
  process.getuid?.() === 0 &&
  process.geteuid?.() === 0 &&
  process.env.OPENCLAW_TEST_FREEBSD_DISPOSABLE === "1";
const reasons = {
  present: "freebsd-service-present",
  unknown: "freebsd-service-inspection-unavailable",
} as const;

afterEach(() => vi.restoreAllMocks());

async function withRcDefinition(status: keyof typeof reasons, operation: () => Promise<void>) {
  if (!disposableGuest) {
    throw new Error("Global rc fixtures require an explicitly marked disposable FreeBSD guest.");
  }
  expect(await discoverFreeBsdService({ registerExitCleanup: onExit })).toMatchObject({
    status: "absent",
  });
  expect(await isFreeBsdGatewayServiceAbsent({})).toBe(true);
  // This suite runs alone in the disposable guest: never replace an operator's
  // definition, execute a service, or remove a file whose ownership has changed.
  const filename = "/etc/rc.d/openclaw";
  const contents = `# disposable update admission fixture ${randomUUID()}\n`;
  const handle = await fs.open(filename, "wx", 0o600);
  const owned = await handle.stat();
  try {
    await handle.writeFile(contents);
    if (status === "unknown") {
      await handle.chmod(0o666);
    }
    expect(await discoverFreeBsdService({ registerExitCleanup: onExit })).toMatchObject(
      status === "present"
        ? { status: "present", definitions: [{ path: filename, executable: false }] }
        : { status: "unknown", reason: "unsafe-path-ownership" },
    );
    expect(await isFreeBsdGatewayServiceAbsent({})).toBe(false);
    await operation();
  } finally {
    try {
      const current = await fs.lstat(filename);
      expect(current.isFile()).toBe(true);
      expect([current.dev, current.ino, current.uid]).toEqual([owned.dev, owned.ino, 0]);
      expect(await fs.readFile(filename, "utf8")).toBe(contents);
      await fs.unlink(filename);
      expect(await discoverFreeBsdService({ registerExitCleanup: onExit })).toMatchObject({
        status: "absent",
      });
    } finally {
      await handle.close();
    }
  }
}

function isolatedEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    OPENCLAW_HOME: undefined,
    OPENCLAW_PROFILE: undefined,
    OPENCLAW_SUPERVISOR_MODE: undefined,
    OPENCLAW_UPDATE_POST_CORE: undefined,
    OPENCLAW_UPDATE_RUN_ID: undefined,
    OPENCLAW_UPDATE_RUN_HANDOFF: undefined,
    [CONTROL_PLANE_UPDATE_SENTINEL_META_ENV]: undefined,
    ...env,
  };
}

describe.skipIf(!disposableGuest)(
  "FreeBSD service discovery remains advisory",
  { concurrent: false },
  () => {
    it.each(["absent", "present", "unknown"] as const)(
      "admits default update and preview without service mutation when rc state is %s",
      async (status) => {
        await withFreeBsdFixture(async ({ root, env }) => {
          await fs.writeFile(
            path.join(root, "package.json"),
            '{"name":"openclaw","version":"1.0.0"}',
          );
          vi.spyOn(shared, "resolveUpdateRoot").mockResolvedValue(root);
          const adapter = service.resolveGatewayService();
          const mutations = ["install", "uninstall", "stop", "restart"] as const;
          const spies = mutations.map((key) => vi.spyOn(adapter, key));
          vi.spyOn(service, "resolveGatewayService").mockReturnValue(adapter);
          const prove = async () => {
            for (const dryRun of [false, true]) {
              const opts = { dryRun };
              const prepared = await prepareUpdateCommand(opts);
              expect(prepared.shouldRestart).toBe(true);
              const run = await admitUpdateCommandRun({
                root,
                opts,
                freebsdWriteAdmission: prepared.freebsdWriteAdmission,
              });
              expect(run.env.OPENCLAW_STATE_DIR).toBe(env.OPENCLAW_STATE_DIR);
              expect(run.freebsdWriteAdmission?.canWrite).toBe(true);
              expect(
                completeUpdateCommandRun(
                  { status: "ok", mode: "npm", steps: [], durationMs: 1 },
                  run,
                ).status,
              ).toBe("ok");
              for (const spy of spies) {
                expect(spy).not.toHaveBeenCalled();
              }
            }
          };
          await withEnvAsync(isolatedEnv(env), () =>
            status === "absent" ? prove() : withRcDefinition(status, prove),
          );
        });
      },
      60_000,
    );
  },
);
