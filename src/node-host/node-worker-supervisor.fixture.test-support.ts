import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import * as serviceChildControl from "../process/supervisor/service-child-control-reader.js";
import type { NodeWorkerLaunchClaim } from "./node-worker-launch-store.js";
import * as workerLaunchTransport from "./node-worker-launch-transport.js";
import {
  inspectNodeWorkerProcessIdentity,
  requireNodeWorkerProcessIdentity,
  type NodeWorkerProcessIdentity,
} from "./node-worker-process-identity.js";
import { createNodeWorkerSupervisor } from "./node-worker-supervisor.js";
import {
  testWorkerLaunchInput,
  writeNodeWorkerFixture,
} from "./node-worker-supervisor.test-support.js";

function writeSupervisorOwnerScript(root: string): string {
  const supervisorUrl = pathToFileURL(path.resolve("src/node-host/node-worker-supervisor.ts")).href;
  const scriptPath = path.join(root, "supervisor-owner.mts");
  fs.writeFileSync(
    scriptPath,
    `
      import fs from "node:fs";
      import { createNodeWorkerSupervisor } from ${JSON.stringify(supervisorUrl)};
      const [bundleRoot, stateDir, inputPath] = process.argv.slice(2);
      const supervisor = createNodeWorkerSupervisor({
        bundleRoot,
        env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
      });
      const shutdown = async () => {
        await supervisor.close();
        process.exit(0);
      };
      process.once("SIGTERM", () => void shutdown());
      const input = JSON.parse(fs.readFileSync(inputPath, "utf8"));
      const receipt = await supervisor.launch(input, ${JSON.stringify({ kind: "unix", socketPath: "/tmp/openclaw-worker/gateway.sock" })});
      process.stdout.write(JSON.stringify(receipt) + "\\n");
      setInterval(() => {}, 1000);
    `,
  );
  return scriptPath;
}

export function spawnPendingSupervisorOwner({
  root,
  env,
  claim,
}: {
  root: string;
  env: NodeJS.ProcessEnv;
  claim: NodeWorkerLaunchClaim;
}): ChildProcess {
  const storeUrl = pathToFileURL(path.resolve("src/node-host/node-worker-launch-store.ts")).href;
  const turnsUrl = pathToFileURL(path.resolve("src/node-host/node-worker-turn-store.ts")).href;
  const journalUrl = pathToFileURL(
    path.resolve("src/node-host/node-worker-journal-worker.ts"),
  ).href;
  const identityUrl = pathToFileURL(
    path.resolve("src/node-host/node-worker-process-identity.ts"),
  ).href;
  const claimPath = path.join(root, "claim.json");
  const scriptPath = path.join(root, "pending-owner.mts");
  fs.writeFileSync(claimPath, JSON.stringify(claim));
  fs.writeFileSync(
    scriptPath,
    `
        import fs from "node:fs";
        import { NodeWorkerJournalWorker } from ${JSON.stringify(journalUrl)};
        import { NodeWorkerLaunchStore } from ${JSON.stringify(storeUrl)};
        import { NodeWorkerTurnStore } from ${JSON.stringify(turnsUrl)};
        import { requireNodeWorkerProcessIdentity } from ${JSON.stringify(identityUrl)};
        const [stateDir, claimPath] = process.argv.slice(2);
        const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
        const journal = new NodeWorkerJournalWorker({ env });
        const store = new NodeWorkerLaunchStore(journal);
        const claim = JSON.parse(fs.readFileSync(claimPath, "utf8"));
        const supervisor = requireNodeWorkerProcessIdentity(process.pid);
        const result = (await store.claim(
          claim,
          supervisor,
          2,
        ));
        const turn = (await new NodeWorkerTurnStore(journal).claim({
          claim, ownerLaunchId: result.receipt.launchId, supervisor,
        }));
        process.stdout.write(JSON.stringify(turn.receipt) + "\\n");
        setInterval(() => {}, 1000);
      `,
  );
  return spawn(
    process.execPath,
    ["--import", "tsx", scriptPath, env.OPENCLAW_STATE_DIR!, claimPath],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
}

export function spawnSupervisorOwner(params: {
  bundleRoot: string;
  env: NodeJS.ProcessEnv;
  input: ReturnType<typeof testWorkerLaunchInput>;
  root: string;
}): ChildProcess {
  const inputPath = path.join(params.root, `${params.input.launchId}.json`);
  fs.writeFileSync(inputPath, JSON.stringify(params.input));
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      writeSupervisorOwnerScript(params.root),
      params.bundleRoot,
      params.env.OPENCLAW_STATE_DIR!,
      inputPath,
    ],
    { env: { ...process.env, ...params.env }, stdio: ["ignore", "pipe", "pipe"] },
  );
  return child;
}

export async function waitForIdentityDeath(identity: NodeWorkerProcessIdentity) {
  await vi.waitFor(
    () => expect(inspectNodeWorkerProcessIdentity(identity)).toMatch(/^(dead|reused)$/u),
    { timeout: 5_000 },
  );
}

export function waitForChildLine(child: ChildProcess): Promise<string> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const onData = (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      const newline = stdout.indexOf("\n");
      if (newline >= 0) {
        resolve(stdout.slice(0, newline));
      }
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      reject(new Error(`owner exited before ready (${code ?? signal}): ${stderr}`));
    });
  });
}

export function waitForChildExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", () => resolve());
  });
}

export function holdNodeWorkerReadiness(launchId: string) {
  const readyCaptured = createDeferred<NodeWorkerProcessIdentity>();
  const releaseReady = createDeferred();
  let targetPreparing = false;
  let readyDelivery: Promise<void> | undefined;
  const prepare = workerLaunchTransport.prepareNodeWorkerLaunchTransport;
  const preparing = vi
    .spyOn(workerLaunchTransport, "prepareNodeWorkerLaunchTransport")
    .mockImplementation(async (options) => {
      if (options.input.launchId !== launchId) {
        return await prepare(options);
      }
      targetPreparing = true;
      try {
        return await prepare(options);
      } finally {
        targetPreparing = false;
      }
    });
  const readControl = serviceChildControl.readServiceChildControl;
  const control = vi
    .spyOn(serviceChildControl, "readServiceChildControl")
    .mockImplementation((stream, onLine, onOverflow) => {
      const target = targetPreparing;
      readControl(
        stream,
        (line) => {
          const message: unknown = JSON.parse(line);
          if (
            target &&
            !readyDelivery &&
            typeof message === "object" &&
            message !== null &&
            "type" in message &&
            message.type === "ready" &&
            "anchorPid" in message &&
            typeof message.anchorPid === "number"
          ) {
            const owner = requireNodeWorkerProcessIdentity(message.anchorPid);
            readyDelivery = releaseReady.promise.then(() => onLine(line));
            readyCaptured.resolve(owner);
            return;
          }
          onLine(line);
        },
        onOverflow,
      );
    });
  return {
    ready: readyCaptured.promise,
    release: () => releaseReady.resolve(),
    async close() {
      releaseReady.resolve();
      try {
        await readyDelivery;
      } finally {
        control.mockRestore();
        preparing.mockRestore();
      }
    },
  };
}

export function observeNodeWorkerAdapters(
  observe: (adapter: workerLaunchTransport.NodeWorkerChildAdapter) => void,
) {
  const prepare = workerLaunchTransport.prepareNodeWorkerLaunchTransport;
  return vi
    .spyOn(workerLaunchTransport, "prepareNodeWorkerLaunchTransport")
    .mockImplementation(async (options) => {
      const transport = await prepare(options);
      if (transport.kind === "started") {
        observe(transport.adapter);
      }
      return transport;
    });
}

export function createNodeWorkerSupervisorFixture(
  root: string,
  options: Parameters<typeof createNodeWorkerSupervisor>[0] = {},
) {
  const fixture = writeNodeWorkerFixture(root);
  const { bundleRoot, env } = fixture;
  return { ...fixture, supervisor: createNodeWorkerSupervisor({ bundleRoot, env, ...options }) };
}

export async function waitForNodeWorkerTerminal(
  supervisor: ReturnType<typeof createNodeWorkerSupervisor>,
  launchId: string,
) {
  await vi.waitFor(
    async () => {
      expect((await supervisor.status(launchId))?.state).not.toMatch(/^(?:pending|running)$/u);
    },
    { timeout: 5_000 },
  );
  const receipt = await supervisor.status(launchId);
  if (!receipt) {
    throw new Error(`missing launch receipt ${launchId}`);
  }
  return receipt;
}
