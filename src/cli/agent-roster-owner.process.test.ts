import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { acquireGatewayLock, type GatewayLockHandle } from "../infra/gateway-lock.js";
import {
  openOpenClawStateDatabase,
  closeOpenClawStateDatabaseAsync,
} from "../state/openclaw-state-db.js";
import { acquireTestPortBlock, type TestPortClaim } from "../test-utils/port-claims.js";
import { localStateOwnerFixtureEntrypoint } from "./cli-entrypoint.test-support.js";
import { stateOwnerEnv } from "./cli-process-fixture.test-support.js";
import { createCliProcessFixture } from "./isolated-process-fixture.test-support.js";

const roots = useAutoCleanupTempDirTracker(afterAll);
const lock = (env: NodeJS.ProcessEnv, port?: number) =>
  acquireGatewayLock({ env, port, allowInTests: true, timeoutMs: 0 });
const createFixture = (root: string) =>
  createCliProcessFixture(root, stateOwnerEnv(root), localStateOwnerFixtureEntrypoint);

let root: string;
let owner: GatewayLockHandle | null;
let claim: TestPortClaim;
let config: string;
let fixture: ReturnType<typeof createFixture>;

beforeAll(async () => {
  root = roots.make("openclaw-agent-roster-owner-");
  fixture = createFixture(root);
  claim = await acquireTestPortBlock({ offsets: [0] });
  config = JSON.stringify({
    agents: { ownership: "explicit", defaults: { skipBootstrap: true }, entries: { main: {} } },
    gateway: { mode: "local", port: claim.port },
  });
  await fs.writeFile(fixture.configPath, config);
  openOpenClawStateDatabase({ env: fixture.env });
  await closeOpenClawStateDatabaseAsync();
  owner = await lock(fixture.env, claim.port);
  expect(owner).not.toBeNull();
});
afterAll(async () => {
  await owner?.release();
  await claim.release();
});

it.each([
  ["setup", "setup --baseline --workspace WORKSPACE --json"],
  ["advanced creation", "agents add advanced --role researcher --workspace WORKSPACE --json"],
  ["team creation", "agents team create --workspace-root WORKSPACE --non-interactive --json"],
])("refuses live %s before creating state", async (name, args) => {
  const workspace = path.join(root, `uncreated-${name.replaceAll(" ", "-")}`);
  const result = await fixture.run(
    args.split(" ").map((arg) => (arg === "WORKSPACE" ? workspace : arg)),
  );
  expect(result.code, result.stderr).toBe(1);
  expect(result.stderr).toContain("exclusive offline state ownership");
  expect(result.stderr).toContain("stop the Gateway");
  expect(await fs.readFile(fixture.configPath, "utf8")).toBe(config);
  await expect(fs.stat(workspace)).rejects.toMatchObject({ code: "ENOENT" });
});

it("creates the roster and workspace after the Gateway releases ownership", async () => {
  await owner?.release();
  owner = null;
  const workspace = path.join(root, "offline-workspace");
  const result = await fixture.run([
    ..."agents add offline --workspace".split(" "),
    workspace,
    "--non-interactive",
    "--json",
  ]);
  expect(result.code, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({ agentId: "offline", workspace });
  const next = await fixture.run(["agents", "list", "--json"]);
  expect(next.code, next.stderr).toBe(0);
  expect(JSON.parse(next.stdout)).toContainEqual(
    expect.objectContaining({ id: "offline", workspace }),
  );
  expect((await fs.stat(workspace)).isDirectory()).toBe(true);
  const successor = await lock(fixture.env);
  expect(successor).not.toBeNull();
  await successor?.release();
});

it("completes offline onboarding and releases ownership for Gateway startup", async () => {
  const offline = createFixture(roots.make("openclaw-onboard-offline-"));
  const workspace = path.join(offline.env.HOME, "workspace");
  const result = await offline.run([
    ..."onboard --non-interactive --accept-risk --agent-name first --workspace".split(" "),
    workspace,
    ..."--auth-choice skip --skip-skills --skip-channels --skip-ui --skip-health --json".split(" "),
  ]);
  expect(result.code, result.stderr).toBe(0);
  expect((await fs.stat(workspace)).isDirectory()).toBe(true);
  const saved = JSON.parse(await fs.readFile(offline.configPath, "utf8"));
  expect(saved.agents.entries.first).toBeDefined();
  const successor = await lock(offline.env);
  expect(successor).not.toBeNull();
  await successor?.release();
});
