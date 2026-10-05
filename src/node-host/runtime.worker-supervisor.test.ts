import fs from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  NODE_WORKER_PRIVATE_COMMANDS,
  NODE_WORKER_SUPERVISOR_LAUNCH_COMMAND,
  NODE_WORKER_SUPERVISOR_STATUS_COMMAND,
  NODE_WORKER_WORKSPACE_EXEC_COMMAND,
} from "../infra/node-commands.js";
import { resetSecretRedactionRegistryForTest } from "../logging/secret-redaction-registry.test-support.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../state/openclaw-state-db.js";
import { reserveTestPortListener } from "../test-utils/port-claims.js";
import type { NodeHostClient } from "./client.js";
import { snapshotNodeWorkerEnv } from "./node-worker-environment.js";
import { NodeWorkerJournalWorker } from "./node-worker-journal-worker.js";
import { NodeWorkerLaunchStore } from "./node-worker-launch-store.js";
import {
  testWorkerLaunchInput,
  writeNodeWorkerFixture,
} from "./node-worker-supervisor.test-support.js";
import { prepareNodeHostRuntime } from "./runtime.js";

vi.mock("../infra/path-env.js", () => ({
  ensureOpenClawCliOnPath: vi.fn(),
}));

vi.mock("./mcp.js", () => ({
  startNodeHostMcpManager: vi.fn(async () => ({
    descriptors: [],
    callMcpTool: vi.fn(),
    close: vi.fn(async () => undefined),
  })),
}));

vi.mock("./plugin-node-host.js", () => ({
  ensureNodeHostPluginRegistry: vi.fn(async () => undefined),
  hasRegisteredNodeHostCommandActiveWork: vi.fn(() => false),
  isRegisteredNodeHostCommandDuplex: vi.fn(() => false),
  listRegisteredNodeHostCapsAndCommands: vi.fn(() => ({
    caps: [],
    commands: [],
    nodePluginTools: [],
  })),
  watchRegisteredNodeHostCommandAvailability: vi.fn(() => () => {}),
  notifyRegisteredNodeHostCommandDisconnect: vi.fn(async () => undefined),
  invokeRegisteredNodeHostCommand: vi.fn(async () => null),
}));

vi.mock("./skills.js", () => ({
  scanNodeHostedSkills: vi.fn(() => []),
  resolveNodeHostedSkillDirectory: vi.fn(() => null),
}));

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
    cleanup();
  }),
);

describe("node-host runtime worker supervisor lifetime", () => {
  it("keeps a claimed worker alive across invoke cancel and reconnect until runtime close", async () => {
    const fixture = writeNodeWorkerFixture(tempDirs.make("node-worker-runtime-"));
    fs.mkdirSync(fixture.stateDir, { recursive: true, mode: 0o700 });
    fs.chmodSync(fixture.stateDir, 0o700);
    fs.renameSync(fixture.bundleRoot, path.join(fixture.stateDir, "node-host"));
    const input = testWorkerLaunchInput(fixture.workspaceDir, "launch-runtime", "wait");
    const launchResponseEntered = createDeferred();
    const launchResponseHeld = createDeferred();
    const responses: Array<{ method: string; params: unknown }> = [];
    const request: NodeHostClient["request"] = async <T = Record<string, unknown>>(
      method: string,
      params?: unknown,
    ): Promise<T> => {
      responses.push({ method, params });
      if (
        method === "node.invoke.result" &&
        (params as { id?: string } | undefined)?.id === "invoke-launch"
      ) {
        launchResponseEntered.resolve();
        await launchResponseHeld.promise;
      }
      return {} as T;
    };
    const prepared = await prepareNodeHostRuntime({
      config: {
        nodeHost: { skills: { enabled: false }, workerRuns: { enabled: true, capacity: 2 } },
      },
      env: { ...fixture.env, PATH: process.env.PATH },
      platform: "linux",
    });
    expect(prepared.workerHostingEnabled, prepared.workerHostingDisabledReason).toBe(true);
    for (const command of NODE_WORKER_PRIVATE_COMMANDS) {
      expect(prepared.manifest.commands, command).not.toContain(command);
    }
    const capacitySnapshots: Array<{ total: number; available: number }> = [];
    const capacityReady = createDeferred();
    const runtime = prepared.start({
      client: { request },
      onRunnerCapacityChanged: (capacity) => {
        capacitySnapshots.push(capacity);
        if (capacity.available === 2) {
          capacityReady.resolve();
        }
      },
    });
    runtime.updateGatewayConnection({ url: "ws://127.0.0.1:18789" });
    const store = new NodeWorkerLaunchStore(new NodeWorkerJournalWorker({ env: fixture.env }));

    try {
      await capacityReady.promise;
      expect(capacitySnapshots).toEqual([
        { total: 2, available: 0 },
        { total: 2, available: 2 },
      ]);
      const launching = runtime.invoke({
        id: "invoke-launch",
        nodeId: "node-1",
        command: NODE_WORKER_SUPERVISOR_LAUNCH_COMMAND,
        paramsJSON: JSON.stringify(input),
      });
      // The journal becomes running before startup settles. Hold the completed
      // launch response so cancellation exercises the admitted worker's lifetime.
      await launchResponseEntered.promise;
      expect((await store.get(input.launchId))?.state).toBe("running");

      runtime.cancel("invoke-launch");
      await runtime.cancelAll();
      expect((await store.get(input.launchId))?.state).toBe("running");
      launchResponseHeld.resolve();
      await launching;
      expect(await runtime.tryPauseForUpdate()).toBe(false);

      await runtime.invoke({
        id: "invoke-status",
        nodeId: "node-1",
        command: NODE_WORKER_SUPERVISOR_STATUS_COMMAND,
        paramsJSON: JSON.stringify({ launchId: input.launchId }),
      });
      const status = responses.find(
        ({ method, params }) =>
          method === "node.invoke.result" &&
          (params as { id?: string } | undefined)?.id === "invoke-status",
      )?.params as { payloadJSON?: string } | undefined;
      expect(JSON.parse(status?.payloadJSON ?? "{}")).toMatchObject({
        launchId: input.launchId,
        state: "running",
      });

      await runtime.invoke({
        id: "invoke-replay",
        nodeId: "node-1",
        command: NODE_WORKER_SUPERVISOR_LAUNCH_COMMAND,
        paramsJSON: JSON.stringify(input),
      });
      expect((await store.get(input.launchId))?.state).toBe("running");
    } finally {
      launchResponseHeld.resolve();
      await runtime.close();
    }

    expect((await store.get(input.launchId))?.state).toBe("interrupted");
  });
});

describe("dedicated worker provider identity transport", () => {
  const header = "synthetic-provider-header";
  const requests: { purposeMatches: boolean; headerMatches: boolean }[] = [];
  let endpoint: string;
  let release: () => Promise<void>;
  beforeAll(async () => {
    const reservation = await reserveTestPortListener({
      offsets: [0],
      createListener: () =>
        createServer((req, res) => {
          requests.push({
            purposeMatches: req.url === "/token?resource=fixture-audience&client_id=fixture-client",
            headerMatches: req.headers["x-identity-header"] === header,
          });
          res.end("MI_TRANSPORT_REACHED");
        }),
    });
    endpoint = `http://127.0.0.1:${reservation.claim.port}/token`;
    release = async () => {
      await reservation.releaseListener();
      await reservation.claim.release();
    };
  });
  afterAll(async () => {
    await release();
  });
  afterEach(() => {
    requests.length = 0;
    resetSecretRedactionRegistryForTest();
  });

  it.each([true, false])(
    "hands provider transport to the real workspace child only for ephemeral=%s",
    async (ephemeral) => {
      const root = tempDirs.make("worker-provider-transport-");
      const env = {
        HOME: root,
        OPENCLAW_STATE_DIR: path.join(root, "state"),
        IDENTITY_ENDPOINT: endpoint,
        IDENTITY_HEADER: header,
        OPENCLAW_GATEWAY_TOKEN: "synthetic-gateway-secret",
        GITHUB_TOKEN: "synthetic-device-secret",
      };
      expect(snapshotNodeWorkerEnv(env)).not.toHaveProperty("IDENTITY_ENDPOINT");
      expect(snapshotNodeWorkerEnv(env)).not.toHaveProperty("IDENTITY_HEADER");
      const prepared = await prepareNodeHostRuntime({
        config: {
          nodeHost: {
            skills: { enabled: false },
            ...(ephemeral ? {} : { workerRuns: { enabled: true } }),
          },
        },
        env,
        ephemeral,
        // Common Crabbox --ephemeral connect enables hosting without a node config override.
        forceWorkerRuns: ephemeral,
      });
      expect(prepared.workerHostingEnabled, prepared.workerHostingDisabledReason).toBe(true);
      expect(JSON.stringify(prepared.manifest)).not.toContain(header);
      const responses: unknown[] = [];
      const request: NodeHostClient["request"] = async <T = Record<string, unknown>>(
        _method: string,
        params?: unknown,
      ): Promise<T> => {
        responses.push(params);
        return {} as T;
      };
      const runtime = prepared.start({ client: { request } });
      const input = {
        gatewayNamespace: "provider-fixture",
        environmentId: "environment-1",
        sessionId: "session-1",
        generation: 1,
        argv: [
          "node",
          "-e",
          `
        if (process.env.OPENCLAW_GATEWAY_TOKEN || process.env.GITHUB_TOKEN) process.exit(31);
        if (!process.env.IDENTITY_ENDPOINT || !process.env.IDENTITY_HEADER) {
          process.stdout.write("transport-unavailable");
        } else {
          require("node:http").get(process.env.IDENTITY_ENDPOINT + "?resource=fixture-audience&client_id=fixture-client",
            { headers: { "X-IDENTITY-HEADER": process.env.IDENTITY_HEADER } }, res => {
              res.setEncoding("utf8"); let body = "";
              res.on("data", chunk => body += chunk);
              res.on("end", () => process.stdout.write(body + "\\n" + process.env.IDENTITY_HEADER));
            }).on("error", () => process.exit(32));
        }
      `,
        ],
      };
      try {
        await runtime.invoke({
          id: "provider-exec",
          nodeId: "node-1",
          command: NODE_WORKER_WORKSPACE_EXEC_COMMAND,
          paramsJSON: JSON.stringify(input),
        });
        const response = responses.at(-1) as {
          ok?: boolean;
          payloadJSON?: string;
          error?: { code?: string; message?: string };
        };
        expect(response.error).toBeUndefined();
        expect(response.ok).toBe(true);
        expect(JSON.parse(response.payloadJSON ?? "{}")).toMatchObject({
          code: 0,
          termination: "exit",
          stdout: ephemeral ? "MI_TRANSPORT_REACHED\n[REDACTED]" : "transport-unavailable",
        });
        expect(requests).toEqual(ephemeral ? [{ purposeMatches: true, headerMatches: true }] : []);
        expect(JSON.stringify(responses)).not.toContain(header);
        await runtime.invoke({
          id: "unapproved-env",
          nodeId: "node-1",
          command: NODE_WORKER_WORKSPACE_EXEC_COMMAND,
          paramsJSON: JSON.stringify({
            ...input,
            env: { IDENTITY_ENDPOINT: endpoint, IDENTITY_HEADER: header },
          }),
        });
        expect(responses.at(-1)).toMatchObject({ ok: false, error: { code: "INVALID_REQUEST" } });
        expect(requests).toHaveLength(ephemeral ? 1 : 0);
      } finally {
        await runtime.close();
      }
    },
  );

  it.each(["IDENTITY_ENDPOINT", "IDENTITY_HEADER"])(
    "refuses incomplete dedicated transport missing %s without ambient fallback",
    async (missing) => {
      const env: NodeJS.ProcessEnv = {
        HOME: tempDirs.make("worker-incomplete-provider-"),
        IDENTITY_ENDPOINT: endpoint,
        IDENTITY_HEADER: header,
      };
      delete env[missing];
      await expect(
        prepareNodeHostRuntime({
          config: { nodeHost: { skills: { enabled: false }, workerRuns: { enabled: true } } },
          env,
          ephemeral: true,
        }),
      ).rejects.toThrow("Worker managed-identity transport is incomplete");
      expect(requests).toEqual([]);
    },
  );
});
