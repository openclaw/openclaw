import fs from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  NODE_WORKER_PRIVATE_COMMANDS,
  NODE_WORKER_SUPERVISOR_LAUNCH_COMMAND,
  NODE_WORKER_WORKSPACE_EXEC_COMMAND,
} from "../infra/node-commands.js";
import * as secretRegistry from "../logging/secret-redaction-registry.js";
import { resetSecretRedactionRegistryForTest } from "../logging/secret-redaction-registry.test-support.js";
import { reserveTestPortListener } from "../test-utils/port-claims.js";
import { useStateDatabaseTempDirs } from "../test-utils/state-database-temp-dirs.js";
import { mockProcessPlatform } from "../test-utils/vitest-spies.js";
import type { NodeHostClient } from "./client.js";
import { NodeWorkerJournalWorker } from "./node-worker-journal-worker.js";
import { NodeWorkerLaunchStore } from "./node-worker-launch-store.js";
import * as worker from "./node-worker-supervisor.test-support.js";
import { NodeWorkerWorkspaceRuntime } from "./node-worker-workspace.js";
import { prepareNodeHostRuntime } from "./runtime.js";

// mock-isolation: worker lifetime proof must not modify the host PATH.
vi.mock("../infra/path-env.js", () => ({ ensureOpenClawCliOnPath: vi.fn() }));

vi.mock("./mcp.js", () => ({
  startNodeHostMcpManager: vi.fn(async () => ({
    descriptors: [],
    callMcpTool: vi.fn(),
    close: vi.fn(async () => undefined),
  })),
}));

// mock-isolation: the supervisor owns real workers here, but no plugin-host services are enabled.
vi.mock("./plugin-node-host.js", () => ({
  ensureNodeHostPluginRegistry: vi.fn(async () => undefined),
  hasRegisteredNodeHostCommandActiveWork: vi.fn(() => false),
  isRegisteredNodeHostCommandDuplex: vi.fn(() => false),
  listRegisteredNodeHostCapsAndCommands: () => ({ caps: [], commands: [], nodePluginTools: [] }),
  watchRegisteredNodeHostCommandAvailability: vi.fn(() => () => {}),
  notifyRegisteredNodeHostCommandDisconnect: vi.fn(async () => undefined),
  invokeRegisteredNodeHostCommand: vi.fn(async () => null),
}));

vi.mock("./skills.js", () => ({
  scanNodeHostedSkills: vi.fn(() => []),
  resolveNodeHostedSkillDirectory: vi.fn(() => null),
}));

const tempDirs = useStateDatabaseTempDirs();

it("keeps a claimed worker alive across invoke cancel and reconnect until runtime close", async () => {
  const platform = mockProcessPlatform("linux");
  onTestFinished(() => platform.mockRestore());
  const fixture = worker.writeNodeWorkerFixture(tempDirs.make("node-worker-runtime-"));
  fs.mkdirSync(fixture.stateDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(fixture.stateDir, 0o700);
  fs.renameSync(fixture.bundleRoot, path.join(fixture.stateDir, "node-host"));
  const input = worker.testWorkerLaunchInput(fixture.workspaceDir, "launch-runtime", "wait");
  const launchResponseEntered = createDeferred();
  const launchResponseHeld = createDeferred();
  const responses = new Map<string, { payloadJSON?: string }>();
  const request: NodeHostClient["request"] = async <T>(method: string, params?: unknown) => {
    if (method === "node.invoke.result") {
      const response = params as { id: string; payloadJSON?: string };
      responses.set(response.id, response);
      if (response.id === "invoke-launch") {
        launchResponseEntered.resolve();
        await launchResponseHeld.promise;
      }
    }
    return {} as T;
  };
  const prepared = await prepareNodeHostRuntime({
    config: {
      nodeHost: { skills: { enabled: false }, workerRuns: { enabled: true, capacity: 2 } },
    },
    env: { ...fixture.env, PATH: process.env.PATH },
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
  const invoke = (id: string, command: string, params: unknown) =>
    runtime.invoke({ id, nodeId: "node-1", command, paramsJSON: JSON.stringify(params) });
  runtime.updateGatewayConnection({ url: "ws://127.0.0.1:18789" });
  const store = new NodeWorkerLaunchStore(new NodeWorkerJournalWorker({ env: fixture.env }));

  try {
    await capacityReady.promise;
    expect(capacitySnapshots).toEqual([0, 2].map((available) => ({ total: 2, available })));
    const launching = invoke("invoke-launch", "worker.launch.v1", input);
    // Hold the completed launch response so cancellation exercises the admitted worker's lifetime.
    await launchResponseEntered.promise;
    expect((await store.get(input.launchId))?.state).toBe("running");

    runtime.cancel("invoke-launch");
    await runtime.cancelAll();
    expect((await store.get(input.launchId))?.state).toBe("running");
    launchResponseHeld.resolve();
    await launching;
    expect(await runtime.tryPauseForUpdate()).toBe(false);

    await invoke("invoke-status", "worker.status.v1", { launchId: input.launchId });
    const status = responses.get("invoke-status");
    expect(JSON.parse(status?.payloadJSON ?? "{}")).toMatchObject({
      launchId: input.launchId,
      state: "running",
    });

    await invoke("invoke-replay", "worker.launch.v1", input);
    expect((await store.get(input.launchId))?.state).toBe("running");
  } finally {
    launchResponseHeld.resolve();
    await runtime.close();
  }

  expect((await store.get(input.launchId))?.state).toBe("interrupted");
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

  it.each([
    { ephemeral: true, preparedHome: false },
    { ephemeral: true, preparedHome: true },
    { ephemeral: false, preparedHome: true },
  ])(
    "delivers node-local transport through workspace and supervisor with %j",
    async ({ ephemeral, preparedHome }) => {
      const fixture = worker.writeNodeWorkerFixture(tempDirs.make("worker-turn-provider-"));
      fs.mkdirSync(fixture.stateDir, { recursive: true, mode: 0o700 });
      fs.renameSync(fixture.bundleRoot, path.join(fixture.stateDir, "node-host"));
      const homeDir = path.join(fixture.root, preparedHome ? "prepared-home" : "node-home");
      fs.mkdirSync(homeDir);
      const env = {
        ...fixture.env,
        PATH: process.env.PATH,
        HOME: preparedHome ? fixture.root : homeDir,
        REQUESTS_CA_BUNDLE: "/trusted/platform-ca-bundle.pem",
        SSL_CERT_FILE: "/trusted/platform-ca-bundle.pem",
        IDENTITY_ENDPOINT: endpoint,
        IDENTITY_HEADER: header,
        OPENCLAW_GATEWAY_TOKEN: "synthetic-gateway-secret",
        GITHUB_TOKEN: "synthetic-device-secret",
      };
      const prepared = await prepareNodeHostRuntime({
        config: {
          nodeHost: {
            skills: { enabled: false },
            ...(ephemeral ? {} : { workerRuns: { enabled: true } }),
          },
        },
        env,
        ephemeral,
        forceWorkerRuns: ephemeral,
      });
      expect(prepared.workerHostingEnabled, prepared.workerHostingDisabledReason).toBe(true);
      const responses: unknown[] = [];
      const request: NodeHostClient["request"] = async <T = Record<string, unknown>>(
        _method: string,
        params?: unknown,
      ): Promise<T> => {
        responses.push(params);
        return {} as T;
      };
      const registerSecret = secretRegistry.registerSecretValueForRedaction;
      vi.spyOn(secretRegistry, "registerSecretValueForRedaction").mockImplementation((value) => {
        registerSecret(value);
        if (value === header) {
          for (let index = 0; index < 600; index += 1) {
            registerSecret(`identity-eviction-${index}`);
          }
        }
      });
      resetSecretRedactionRegistryForTest();
      const runtime = prepared.start({ client: { request } });
      runtime.updateGatewayConnection({ url: "ws://127.0.0.1:18789" });
      const workspaceInput = {
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
      const input = worker.testWorkerLaunchInput(
        fixture.workspaceDir,
        "identity-turn",
        "managed-identity",
      );
      const store = new NodeWorkerLaunchStore(new NodeWorkerJournalWorker({ env: fixture.env }));
      try {
        await runtime.invoke({
          id: "provider-exec",
          nodeId: "node-1",
          command: NODE_WORKER_WORKSPACE_EXEC_COMMAND,
          paramsJSON: JSON.stringify(workspaceInput),
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
            ...workspaceInput,
            env: { IDENTITY_ENDPOINT: endpoint, IDENTITY_HEADER: header },
          }),
        });
        expect(responses.at(-1)).toMatchObject({ ok: false, error: { code: "INVALID_REQUEST" } });
        expect(requests).toHaveLength(ephemeral ? 1 : 0);
        if (preparedHome) {
          // The workspace owner supplies HOME; the real supervisor still owns child launch.
          vi.spyOn(
            NodeWorkerWorkspaceRuntime.prototype,
            "acquirePreparedWorkspace",
          ).mockResolvedValue({
            workspaceDir: fixture.workspaceDir,
            homeDir,
            assertCurrent: () => {},
            release: () => {},
          });
        }
        await runtime.invoke({
          id: "launch-identity-turn",
          nodeId: "node-1",
          command: NODE_WORKER_SUPERVISOR_LAUNCH_COMMAND,
          paramsJSON: JSON.stringify(input),
        });
        await vi.waitFor(async () => {
          expect((await store.get(input.launchId))?.state).toBe("failed");
        });
        expect(
          JSON.parse(
            fs.readFileSync(path.join(fixture.workspaceDir, "identity-turn.identity.json"), "utf8"),
          ),
        ).toEqual({
          home: homeDir,
          output: ephemeral ? "MI_TRANSPORT_REACHED" : "transport-unavailable",
        });
        const childEnv = JSON.parse(
          fs.readFileSync(path.join(fixture.workspaceDir, "identity-turn.env.json"), "utf8"),
        );
        expect(childEnv.REQUESTS_CA_BUNDLE).toBe(ephemeral ? env.REQUESTS_CA_BUNDLE : undefined);
        expect(childEnv.SSL_CERT_FILE).toBe(ephemeral ? env.SSL_CERT_FILE : undefined);
        expect(requests).toEqual(
          ephemeral
            ? Array.from({ length: 2 }, () => ({ purposeMatches: true, headerMatches: true }))
            : [],
        );
        const receipt = await store.get(input.launchId);
        expect(secretRegistry.isSecretValueRegisteredForRedaction(header)).toBe(false);
        expect(receipt?.errorText).toContain(ephemeral ? "[REDACTED]" : "transport-unavailable");
        expect(JSON.stringify([prepared.manifest, input, responses, receipt])).not.toContain(
          header,
        );
      } finally {
        await runtime.close();
        vi.restoreAllMocks();
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
