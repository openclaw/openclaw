import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, vi } from "vitest";
import type { GatewayService } from "../../daemon/service.js";
import { mockSystemAccountHome } from "../../daemon/service.test-helpers.js";
import * as openClawTmp from "../../infra/tmp-openclaw-dir.js";
import { makeTempWorkspace } from "../../test-helpers/workspace.js";
import { withEnvAsync } from "../../test-utils/env.js";

const mocks = vi.hoisted(() => ({
  service: vi.fn<() => GatewayService>(),
  taskState: 3 as number | string,
}));

export { mocks };

vi.mock("../../daemon/service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../daemon/service.js")>()),
  resolveGatewayService: mocks.service,
}));

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawnSync: vi.fn(() => ({
    pid: 0,
    output: [null, JSON.stringify({ state: mocks.taskState, lastRunResult: 0 }), ""],
    stdout: JSON.stringify({ state: mocks.taskState, lastRunResult: 0 }),
    stderr: "",
    status: 0,
    signal: null,
  })),
}));

beforeEach(() => mockSystemAccountHome());
afterEach(() => vi.restoreAllMocks());

export async function withServiceHome(run: (home: string) => Promise<void>): Promise<void> {
  const home = await makeTempWorkspace("openclaw-update-service-");
  vi.spyOn(openClawTmp, "resolvePreferredOpenClawTmpDir").mockReturnValue(home);
  try {
    await withEnvAsync(
      {
        HOME: home,
        USERPROFILE: home,
        APPDATA: path.join(home, "AppData"),
        OPENCLAW_GATEWAY_PORT: undefined,
        OPENCLAW_HOME: undefined,
        OPENCLAW_STATE_DIR: undefined,
        OPENCLAW_CONFIG_PATH: undefined,
        OPENCLAW_PROFILE: undefined,
        OPENCLAW_SUPERVISOR_MODE: undefined,
        OPENCLAW_SERVICE_MARKER: undefined,
        OPENCLAW_SERVICE_KIND: undefined,
      },
      () => run(home),
    );
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
}
