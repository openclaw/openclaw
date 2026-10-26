import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import type { WorkerProvider, WorkerSshEndpoint } from "../plugins/types.js";
import type { CommandOptions, SpawnResult } from "../process/exec.js";
import * as stateDatabase from "../state/openclaw-state-db.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import { setupGatewaySessionsHandlerTestHarness } from "./test/server-sessions.test-helpers.js";
import { bootstrapWorker } from "./worker-environments/bootstrap.js";
import { WORKER_PROTOCOL_FEATURES } from "./worker-environments/placement-lifecycle.test-support.js";
import { createWorkerSessionPlacementStore } from "./worker-environments/placement-store.js";
import { createProviderReplayDispatch } from "./worker-environments/provider-replay.test-support.js";
import { deriveEnvironmentIntent } from "./worker-environments/service-contract.js";
import {
  createWorkerEnvironmentService,
  type WorkerEnvironmentService,
} from "./worker-environments/service.js";
import { BUNDLE_ARTIFACT, BOOTSTRAP_RECEIPT } from "./worker-environments/service.test-support.js";
import { createWorkerEnvironmentStore } from "./worker-environments/store.js";
import type { WorkerSshRunner } from "./worker-environments/tunnel-ssh-runner.js";
import { createWorkerTunnelManager } from "./worker-environments/tunnel.js";
import {
  localWorkspaceRunner,
  resolveIdentity as fixtureIdentity,
  BUNDLE_HASH,
  SSH,
  success,
} from "./worker-environments/tunnel.test-support.js";
import { rsyncArgvPort, sshArgvPort } from "./worker-environments/worker-ssh-argv.test-support.js";
import { createWorkerWorkspaceRecoveryFixture } from "./worker-environments/workspace-recovery.test-support.js";
import { initializeScriptGitWorkspace } from "./worker-environments/workspace-sync-scripts.test-support.js";

setupGatewaySessionsHandlerTestHarness();
const PRIMARY_PORT = 2222;
const FALLBACK_PORT = 22;
const SESSION_ID = "session-original-order";
const SESSION_KEY = "agent:main:original-order";
const sessionIdentity = { sessionId: SESSION_ID, sessionKey: SESSION_KEY, agentId: "main" };
const PROFILE_ID = "development";
const ENVIRONMENT_ID = deriveEnvironmentIntent(`session-dispatch:${SESSION_ID}:1`).environmentId;
const RECEIPT = {
  ...BOOTSTRAP_RECEIPT,
  openclawVersion: "2026.8.1",
  protocolFeatures: [...WORKER_PROTOCOL_FEATURES],
};
const INSTALLATION = { ...BUNDLE_ARTIFACT, ...RECEIPT };
const SSH_ENDPOINT: WorkerSshEndpoint = {
  ...SSH,
  port: PRIMARY_PORT,
  fallbackPorts: [FALLBACK_PORT],
};

function expectOrdered(actual: readonly string[], expected: readonly string[]): void {
  let previousIndex = -1;
  for (const event of expected) {
    const index = actual.indexOf(event, previousIndex + 1);
    expect(index, `missing ordered event ${event}\n${actual.join("\n")}`).toBeGreaterThan(
      previousIndex,
    );
    previousIndex = index;
  }
}

class OriginalOrderSshRunner implements WorkerSshRunner {
  readonly events: string[] = [];
  bootstrapUploadPath = "";
  private readonly workspace: WorkerSshRunner;

  constructor(private readonly remoteHome: string) {
    this.workspace = localWorkspaceRunner(remoteHome).runner;
  }

  setBootstrapOperationId(operationId: string): void {
    const token = createHash("sha256").update(operationId).digest("hex");
    this.bootstrapUploadPath = path.join(
      this.remoteHome,
      ".openclaw-worker",
      ".incoming",
      `openclaw-upload-${BUNDLE_HASH}.tgz.${token}`,
    );
  }

  start(): never {
    throw new Error("remote-exec workspace transport must not start a persistent SSH process");
  }

  async run(argv: string[], options: CommandOptions): Promise<SpawnResult> {
    if (argv[0] === "git") {
      return await this.workspace.run(argv, options);
    }
    const port =
      argv[0] === "ssh"
        ? sshArgvPort(argv)
        : argv[0] === "rsync"
          ? rsyncArgvPort(argv)
          : Number(argv[argv.indexOf("-P") + 1]);
    const input = typeof options.input === "string" ? options.input : "";
    if (argv[0] === "ssh" && input.includes("expected_receipt=$2")) {
      this.events.push(`bootstrap:preflight:${port}`);
      if (port === PRIMARY_PORT) {
        return { ...success(), code: 255, stderr: "primary transport unavailable" };
      }
      return success(`OPENCLAW_WORKER_BOOTSTRAP_V1\tinstall\t${this.bootstrapUploadPath}\n`);
    }
    if (argv[0] === "scp") {
      this.events.push(`bootstrap:transfer:${port}`);
      return success();
    }
    if (argv[0] === "ssh" && input.includes("receipt_matches()")) {
      this.events.push(`bootstrap:install:${port}`);
      return success(`OPENCLAW_WORKER_BOOTSTRAP_V1\treceipt\t${JSON.stringify(RECEIPT)}\n`);
    }
    if (argv[0] === "ssh" && input.includes("operation_token=$2")) {
      this.events.push(`bootstrap:cleanup:${port}`);
      return success();
    }
    if (argv[0] === "rsync") {
      this.events.push(`workspace:transfer:${port}`);
      return await this.workspace.run(argv, options);
    }
    if (argv[0] === "ssh") {
      this.events.push(`workspace:command:${port}`);
      return await this.workspace.run(argv, {
        ...options,
        baseEnv: {
          ...options.baseEnv,
          PATH: `${path.join(this.remoteHome, "fixture-bin")}:${options.baseEnv?.PATH ?? ""}`,
        },
      });
    }
    throw new Error(`unexpected command: ${argv[0] ?? "missing"}`);
  }
}

async function installRemoteProcessFixture(remoteHome: string): Promise<void> {
  const bin = path.join(remoteHome, "fixture-bin");
  await fs.mkdir(bin, { recursive: true });
  // A real worker host has a dedicated UID. Keep the production quiescence script intact while
  // presenting only its own control process, so it never signals unrelated host-user processes.
  const script = `#!/usr/bin/env node
const args = process.argv.slice(2).join(" ");
const started = "Sat Aug  8 00:00:00 2026";
if (args.includes("-axo")) {
  process.stdout.write(String(process.ppid) + " 0 " + String(process.getuid()) + " S " + started + "\\n");
} else if (args.includes("stat=,lstart=")) {
  process.stdout.write("S " + started + "\\n");
} else {
  process.stdout.write(started + "\\n");
}
`;
  const psPath = path.join(bin, "ps");
  await fs.writeFile(psPath, script, { mode: 0o700 });
  await fs.chmod(psPath, 0o700);
}

async function destroyRemoteProcessFixture(remoteHome: string): Promise<void> {
  const leaseDirectory = path.join(remoteHome, ".openclaw-worker", "quiescence");
  const leases = await fs.readdir(leaseDirectory).catch(() => []);
  for (const name of leases) {
    const leasePath = path.join(leaseDirectory, name);
    const lease = JSON.parse(await fs.readFile(leasePath, "utf8")) as {
      watchdog?: { pid?: number } | null;
    };
    const watchdogPid = lease.watchdog?.pid;
    if (typeof watchdogPid === "number" && Number.isSafeInteger(watchdogPid) && watchdogPid > 0) {
      try {
        process.kill(watchdogPid, "SIGTERM");
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) {
          throw error;
        }
      }
    }
    await fs.rm(leasePath, { force: true });
  }
}

let root: string | undefined;
let tunnelManager: ReturnType<typeof createWorkerTunnelManager> | undefined;
let workerService: WorkerEnvironmentService | undefined;

afterEach(async () => {
  await workerService?.stop();
  workerService = undefined;
  await tunnelManager?.stopAll();
  tunnelManager = undefined;
  await stateDatabase.closeOpenClawStateDatabaseAsync();
  stateDatabase.closeOpenClawStateDatabaseForTest();
  if (root) {
    await fs.rm(root, { recursive: true, force: true });
    root = undefined;
  }
});

test("preserves ordered fallback through inventory rehydration, workspace sync, and reclaim", async () => {
  root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "openclaw-worker-order-"));
  const stateDir = path.join(root, "state");
  const remoteHome = path.join(root, "remote-home");
  const localWorkspace = path.join(root, "workspace");
  await Promise.all([
    fs.mkdir(remoteHome, { recursive: true }),
    fs.mkdir(localWorkspace, { recursive: true }),
  ]);
  await installRemoteProcessFixture(remoteHome);
  await fs.writeFile(path.join(localWorkspace, "current.txt"), "current\n");
  await initializeScriptGitWorkspace(localWorkspace, "current.txt");
  const runner = new OriginalOrderSshRunner(remoteHome);
  const events = runner.events;
  const provider: WorkerProvider = {
    id: "ordered-fallback",
    resolveAllocation: async () => ({ leaseId: "lease-original-order", sharedHost: false }),
    supportedExecutionModes: ["remote-exec"],
    provision: async () => {
      events.push("provider:provision");
      return { leaseId: "lease-original-order", ssh: SSH_ENDPOINT };
    },
    inspect: async () => ({ status: "active" }),
    destroy: async () => {
      await destroyRemoteProcessFixture(remoteHome);
      events.push("provider:destroy");
    },
  };

  const database = stateDatabase.openOpenClawStateDatabase({
    env: { OPENCLAW_STATE_DIR: stateDir },
  });
  const environmentStore = await createWorkerEnvironmentStore({ database, now: () => 2_000 });
  const placements = createWorkerSessionPlacementStore({ database, now: () => 3_000 });
  tunnelManager = createWorkerTunnelManager({ runner });
  const profiles = { [PROFILE_ID]: { provider: provider.id, settings: {} } };
  const environmentService = createWorkerEnvironmentService({
    scheduler: createTestGatewayScheduler(),
    store: environmentStore,
    getConfig: () => ({ cloudWorkers: { profiles } }),
    resolveProvider: (providerId) => (providerId === provider.id ? provider : undefined),
    prepareInstallation: async () => INSTALLATION,
    bootstrapWorker: async (request) => {
      const { operationId, sshEndpoint, installation, resolveIdentity, signal } = request;
      runner.setBootstrapOperationId(operationId);
      events.push("inventory:rehydrate");
      expect(
        (await createWorkerEnvironmentStore({ database, now: () => 2_000 })).get(ENVIRONMENT_ID),
      ).toMatchObject({ state: "bootstrapping", sshEndpoint: SSH_ENDPOINT });
      return await bootstrapWorker(
        {
          operationId,
          ssh: sshEndpoint,
          artifact: installation,
          pinnedHostKey: sshEndpoint.hostKey,
        },
        {
          resolveIdentity,
          runCommand: (argv, options) => runner.run(argv, options),
          signal,
        },
      );
    },
    resolveSshIdentity: fixtureIdentity,
    tunnelManager,
    generateWorkerCredential: () => "original-order-credential",
    liveEvents: {
      apply: async () => ({ ok: true, result: { ackedSeq: 1 } }),
      clear: () => {},
      clearEnvironment: () => {},
      rotateCredential: () => true,
    },
  });
  workerService = environmentService;
  const dispatch = createProviderReplayDispatch({
    initialPlacements: await placements.listAsync(),
    placements,
    environments: {
      ...environmentService,
      startTunnel: async (request) => {
        const handle = await environmentService.startTunnel(request);
        return {
          ...handle,
          quiesceWorkspace: async (remoteWorkspaceDir) => {
            const quiescence = await handle.quiesceWorkspace(remoteWorkspaceDir);
            events.push("workspace:quiesce");
            return {
              assertActive: async () => {
                await quiescence.assertActive();
                events.push("workspace:renew-quiescence");
              },
              resume: async () => await quiescence.resume(),
            };
          },
        };
      },
    },
    runRecoveryBarrier: async ({ run }) => await run({ kind: "local", path: localWorkspace }),
    runReclaimBarrier: async ({ begin, reclaim }) =>
      await reclaim({ kind: "local", path: localWorkspace }, await begin()),
    ...createWorkerWorkspaceRecoveryFixture({
      resolveWorkspace: async () => ({ kind: "local", path: localWorkspace }),
    }),
  });

  const active = await dispatch.dispatch({
    ...sessionIdentity,
    profileId: PROFILE_ID,
    executionMode: "remote-exec",
  });
  expect(active).toMatchObject({ state: "active", environmentId: ENVIRONMENT_ID });
  events.push("placement:active");
  await expect(dispatch.reclaim(sessionIdentity)).resolves.toMatchObject({
    state: "reclaimed",
    environmentId: ENVIRONMENT_ID,
  });
  expect(workerService.get(ENVIRONMENT_ID)).toMatchObject({ state: "destroyed" });
  expect(placements.get(SESSION_ID)).toMatchObject({ state: "reclaimed" });
  events.push("placement:reclaimed");

  expectOrdered(events, [
    "provider:provision",
    "inventory:rehydrate",
    `bootstrap:preflight:${PRIMARY_PORT}`,
    `bootstrap:preflight:${FALLBACK_PORT}`,
    `bootstrap:transfer:${FALLBACK_PORT}`,
    `bootstrap:install:${FALLBACK_PORT}`,
    `bootstrap:cleanup:${FALLBACK_PORT}`,
    `workspace:transfer:${PRIMARY_PORT}`,
    "placement:active",
    "workspace:quiesce",
    "workspace:renew-quiescence",
    "provider:destroy",
    "placement:reclaimed",
  ]);
});
