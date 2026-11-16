import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { runCliProcessChild } from "../cli/cli-process-child.test-helpers.js";
import { cliChildEnv } from "../cli/cli-process-fixture.test-support.js";
import { listDirectoryTreeStrict } from "../infra/directory-walk.js";
import { acquireGatewayLock, type GatewayLockHandle } from "../infra/gateway-lock.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db.js";
import { captureEnv } from "../test-utils/env.js";
import { acquireTestPortBlock, type TestPortClaim } from "../test-utils/port-claims.js";
import { prepareUserProfileCatalogForTest } from "../test-utils/user-profile-catalog.js";
import { startGatewayServer } from "./server.js";
import { createPluginEnabledGatewayTestEnv, GATEWAY_TEST_ENV_KEYS } from "./test-helpers.env.js";

// The wizard runs in a separate process: an in-process call would borrow the
// Gateway owner and miss the post-start onboarding regression.
const roots = useAutoCleanupTempDirTracker(afterAll);
const restoreEnv = captureEnv([
  ...GATEWAY_TEST_ENV_KEYS,
  "OPENCLAW_HOME",
  "CLAUDE_CONFIG_DIR",
  "CODEX_HOME",
  "HERMES_HOME",
]);
let env: NodeJS.ProcessEnv;
let workspace: string;
let source: string;
let claim: TestPortClaim;
let lock: GatewayLockHandle | null;
let server: Awaited<ReturnType<typeof startGatewayServer>> | undefined;
let releaseProfiles: (() => void) | undefined;
const memory = "# Synthetic Claude memory\nRemember the selected workspace.\n";

beforeAll(async () => {
  const root = await fs.realpath(roots.make("openclaw-memory-onboarding-"));
  workspace = path.join(root, "selected-workspace");
  source = path.join(root, ".claude", "projects", "example", "memory", "MEMORY.md");
  claim = await acquireTestPortBlock({ offsets: [0] });
  const token = "synthetic-memory-onboarding-token";
  env = cliChildEnv(root, {
    CLAUDE_CONFIG_DIR: path.join(root, ".claude"),
    CODEX_HOME: path.join(root, ".codex"),
    HERMES_HOME: path.join(root, ".hermes"),
    ...createPluginEnabledGatewayTestEnv(),
  });
  await fs.mkdir(env.OPENCLAW_STATE_DIR!, { recursive: true });
  await fs.mkdir(path.dirname(source), { recursive: true });
  await fs.writeFile(source, memory);
  await fs.writeFile(
    env.OPENCLAW_CONFIG_PATH!,
    JSON.stringify({
      gateway: { mode: "local", port: claim.port, auth: { mode: "token", token } },
      agents: {
        defaults: { workspace: path.join(root, "unused-workspace") },
        entries: { main: { workspace } },
      },
    }),
  );
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  lock = await acquireGatewayLock({ port: claim.port, allowInTests: true, timeoutMs: 0 });
  expect(lock).not.toBeNull();
  server = await startGatewayServer(claim.port, {
    auth: { mode: "token", token },
    controlUiEnabled: false,
    gatewayStateOwner: lock!,
  });
  await server.startupSettled;
  releaseProfiles = (await prepareUserProfileCatalogForTest()).release;
}, 120_000);

afterAll(async () => {
  releaseProfiles?.();
  await server?.close();
  await closeOpenClawStateDatabaseAsync();
  await lock?.release();
  await claim?.release();
  restoreEnv.restore();
});

it("continues with a running Gateway, preserves declined memories, then copies into the final workspace", async () => {
  const entry = pathToFileURL(path.resolve("src/wizard/setup.memory-import.ts")).href;
  const run = async (confirm: boolean) => {
    const script = `
      import fs from 'node:fs/promises';
      const { runSetupMemoryImportStep } = await import(${JSON.stringify(entry)});
      const config = JSON.parse(await fs.readFile(process.env.OPENCLAW_CONFIG_PATH, 'utf8'));
      const outcome = await runSetupMemoryImportStep({ config, agentId: 'main',
        runtime: { log() {}, error: console.error, exit(code) { throw new Error('exit '+code); } },
        prompter: { intro: async()=>{}, outro: async()=>{}, note: async()=>{},
          confirm: async()=>${confirm}, select: async()=> 'skip', text: async()=>'',
          multiselect: async p=>p.initialValues, progress: ()=>({update(){},stop(){}}) }
      });
      console.log(JSON.stringify(outcome));
    `;
    const result = await runCliProcessChild({
      nodeArgs: ["--import", import.meta.resolve("tsx"), "--input-type=module", "--eval", script],
      env,
    });
    expect(result.code, result.stderr).toBe(0);
    return JSON.parse(result.stdout.trim().split("\n").at(-1)!);
  };
  expect(await run(false)).toEqual({ status: "skipped", providers: [] });
  expect(await fs.readFile(source, "utf8")).toBe(memory);
  await expect(fs.access(path.join(workspace, "memory"))).rejects.toThrow();
  expect(await run(true)).toEqual({
    status: "completed",
    providers: [{ providerId: "claude", label: "Claude", migrated: 1, skipped: 0 }],
  });
  const imported = (await listDirectoryTreeStrict(workspace))
    .map((file) => file.relativePath)
    .filter((file) => file.endsWith("MEMORY.md"));
  expect(imported).toHaveLength(1);
  expect(await fs.readFile(path.join(workspace, imported[0]!), "utf8")).toBe(memory);
  expect(await fs.readFile(source, "utf8")).toBe(memory);
  expect(await run(true)).toEqual({ status: "nothing-to-import", providers: [] });
}, 120_000);
