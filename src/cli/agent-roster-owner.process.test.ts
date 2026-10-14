import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { acquireGatewayLock, type GatewayLockHandle } from "../infra/gateway-lock.js";
import { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import {
  openOpenClawStateDatabase,
  closeOpenClawStateDatabaseAsync,
} from "../state/openclaw-state-db.js";
import { acquireTestPortBlock, type TestPortClaim } from "../test-utils/port-claims.js";
import { localStateOwnerFixtureEntrypoint } from "./cli-entrypoint.test-support.js";
import { runCliProcessChild } from "./cli-process-child.test-helpers.js";

const roots = useAutoCleanupTempDirTracker(afterAll);
const entrypoint = resolveRuntimeWorkerArgv(
  resolveRuntimeWorkerUrl(localStateOwnerFixtureEntrypoint),
);

function environment(root: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    HOME: root,
    USERPROFILE: root,
    OPENCLAW_HOME: root,
    OPENCLAW_STATE_DIR: path.join(root, "state"),
    OPENCLAW_CONFIG_PATH: path.join(root, "openclaw.json"),
    OPENCLAW_NO_RESPAWN: "1",
    OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
    NODE_DISABLE_COMPILE_CACHE: "1",
  };
}

describe("agent roster offline ownership", () => {
  let root: string;
  let env: NodeJS.ProcessEnv;
  let owner: GatewayLockHandle | null;
  let claim: TestPortClaim;
  let config: string;

  beforeAll(async () => {
    root = roots.make("openclaw-agent-roster-owner-");
    env = environment(root);
    claim = await acquireTestPortBlock({ offsets: [0] });
    config = JSON.stringify({
      agents: { ownership: "explicit", defaults: { skipBootstrap: true }, entries: { main: {} } },
      gateway: { mode: "local", port: claim.port },
    });
    await fs.writeFile(env.OPENCLAW_CONFIG_PATH!, config);
    openOpenClawStateDatabase({ env });
    await closeOpenClawStateDatabaseAsync();
    owner = await acquireGatewayLock({ env, port: claim.port, allowInTests: true, timeoutMs: 0 });
    expect(owner).not.toBeNull();
  });
  afterAll(async () => {
    await owner?.release();
    await claim.release();
  });

  it.each([
    ["setup", ["setup", "--baseline", "--workspace", "WORKSPACE", "--json"]],
    [
      "advanced creation",
      ["agents", "add", "advanced", "--role", "researcher", "--workspace", "WORKSPACE", "--json"],
    ],
    [
      "team creation",
      ["agents", "team", "create", "--workspace-root", "WORKSPACE", "--non-interactive", "--json"],
    ],
  ])("refuses live %s before creating state", async (name, args) => {
    const workspace = path.join(root, `uncreated-${name.replaceAll(" ", "-")}`);
    const result = await runCliProcessChild({
      nodeArgs: [...entrypoint, ...args.map((arg) => (arg === "WORKSPACE" ? workspace : arg))],
      env,
    });
    expect(result.code, result.stderr).toBe(1);
    expect(result.stderr).toContain("exclusive offline state ownership");
    expect(result.stderr).toContain("stop the Gateway");
    expect(await fs.readFile(env.OPENCLAW_CONFIG_PATH!, "utf8")).toBe(config);
    await expect(fs.stat(workspace)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("creates the roster and workspace after the Gateway releases ownership", async () => {
    await owner?.release();
    owner = null;
    const workspace = path.join(root, "offline-workspace");
    const result = await runCliProcessChild({
      nodeArgs: [
        ...entrypoint,
        "agents",
        "add",
        "offline",
        "--workspace",
        workspace,
        "--non-interactive",
        "--json",
      ],
      env,
    });
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ agentId: "offline", workspace });
    const next = await runCliProcessChild({
      nodeArgs: [...entrypoint, "agents", "list", "--json"],
      env,
    });
    expect(next.code, next.stderr).toBe(0);
    expect(JSON.parse(next.stdout)).toContainEqual(
      expect.objectContaining({ id: "offline", workspace }),
    );
    expect((await fs.stat(workspace)).isDirectory()).toBe(true);
    const successor = await acquireGatewayLock({ env, allowInTests: true, timeoutMs: 0 });
    expect(successor).not.toBeNull();
    await successor?.release();
  });

  it("completes offline onboarding and releases ownership for Gateway startup", async () => {
    const home = roots.make("openclaw-onboard-offline-");
    const offline = environment(home);
    const workspace = path.join(home, "workspace");
    const result = await runCliProcessChild({
      nodeArgs: [
        ...entrypoint,
        "onboard",
        "--non-interactive",
        "--accept-risk",
        "--agent-name",
        "first",
        "--workspace",
        workspace,
        "--auth-choice",
        "skip",
        "--skip-skills",
        "--skip-channels",
        "--skip-ui",
        "--skip-health",
        "--json",
      ],
      env: offline,
    });
    expect(result.code, result.stderr).toBe(0);
    expect((await fs.stat(workspace)).isDirectory()).toBe(true);
    const saved = JSON.parse(await fs.readFile(offline.OPENCLAW_CONFIG_PATH!, "utf8"));
    expect(saved.agents.entries.first).toBeDefined();
    const successor = await acquireGatewayLock({ env: offline, allowInTests: true, timeoutMs: 0 });
    expect(successor).not.toBeNull();
    await successor?.release();
  });
});
