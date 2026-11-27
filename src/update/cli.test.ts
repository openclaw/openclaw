import fs from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { validateUpdateRunParams } from "../../packages/gateway-protocol/src/index.js";
import { GATEWAY_SERVER_CAPS } from "../../packages/gateway-protocol/src/server-capabilities.js";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  nextEventLoopTurn,
  withinTest,
} from "../../test/helpers/promise.js";
import { waitForFast } from "../../test/helpers/vitest-wait.js";
import type * as UpdateCliShared from "../cli/update-cli/shared.js";
import type * as ConfigMutate from "../config/mutate.js";
import { GatewayCredentialsRequiredError } from "../gateway/call-device-auth.js";
import type { CallGatewayOptions } from "../gateway/call-options.js";
import {
  buildMinimalGatewayHelloOkPayload,
  closeMinimalGatewayServer,
  parseMinimalGatewayRequestFrame,
  sendMinimalGatewayConnectChallenge,
  sendMinimalGatewayResponse,
} from "../gateway/minimal-gateway.test-helpers.js";
import * as openclawRoot from "../infra/openclaw-root.js";
import * as updateRunReader from "../infra/update-run-reader.js";
import type { UpdateRunRecord } from "../infra/update-run-record.js";
import { runCommandWithTimeout } from "../process/exec.js";
import { defaultRuntime } from "../runtime.js";
import * as resolveStore from "../secrets/resolve-store.js";
import * as stateDatabaseCache from "../state/openclaw-state-db-cache.js";
import { reserveTestPortListener } from "../test-utils/port-claims.js";
import { createTempHomeEnv, type TempHomeEnv } from "../test-utils/temp-home.js";
import { VERSION } from "../version.js";
import {
  runReleaseUpdateCli,
  tryAdoptInstalledPackageForGateway,
  waitForReleaseUpdateFailure,
} from "./cli.js";
import * as installationIdentity from "./installation-identity.js";
import { TRIAL_BUDGET_MS } from "./launcher.js";
import { createTrialPending, resolvePrefix, switchLink, writeTrial } from "./store.js";
import * as releaseStore from "./store.js";
import type * as TargetModule from "./target.js";

let home: TempHomeEnv;
let root: string;
const capabilities = vi.hoisted(() => [] as boolean[]);
beforeEach(async () => {
  home = await createTempHomeEnv("update-cli-identity-");
  root = path.join(home.home, "checkout");
  await fs.mkdir(root);
  await runCommandWithTimeout(["git", "init", root], { timeoutMs: 10_000 });
  // The selected release is this build's version unless a case asks for a downgrade.
  packageTarget.version = VERSION;
});

const sent = vi.hoisted(() => [] as unknown[]);
const missingCredentials = vi.hoisted(() => ({ enabled: false }));
const install = vi.hoisted(() => ({ kind: "git" }));
const localRun = vi.hoisted((): Pick<UpdateRunRecord, "status" | "phase" | "origin"> => ({
  status: "skipped",
  phase: "finished",
  origin: {},
}));
const packageTarget = vi.hoisted(() => ({ version: "" }));
const confirmDowngrade = vi.hoisted(() =>
  vi.fn<() => Promise<"confirmed" | "cancelled" | "confirmation-required">>(),
);
const createRun = vi.hoisted(() => vi.fn(async () => ({ runId: "run-cli" })));
const mutateConfig = vi.hoisted(() => vi.fn());
vi.mock("../config/mutate.js", async (importOriginal) => ({
  ...(await importOriginal<typeof ConfigMutate>()),
  mutateConfigFileWithRetry: mutateConfig,
}));
vi.mock("../cli/update-cli/shared.js", async (importOriginal) => ({
  ...(await importOriginal<typeof UpdateCliShared>()),
  requestUpdateDowngradeConfirmation: confirmDowngrade,
}));
vi.mock("./target.js", async (importOriginal) => ({
  ...(await importOriginal<typeof TargetModule>()),
  resolveTarget: async () => ({
    kind: "package",
    spec: `openclaw@${packageTarget.version}`,
    version: packageTarget.version,
  }),
}));
vi.mock("../infra/update-install-status.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/update-install-status.js")>()),
  resolveStartupInstallStatus: async () => ({
    root: "/tmp/openclaw-checkout",
    status: {
      root: "/tmp/openclaw-checkout",
      installKind: install.kind,
      packageManager: "pnpm",
      git: { upstream: "origin/main", tag: "v2026.11.6", branch: null },
    },
    installReceipt: null,
  }),
}));
const prepared = vi.hoisted(() => [] as unknown[]);
const maintainRuntimes = vi.hoisted(() =>
  vi.fn(async (_repair: boolean, _authority: { assertCurrent: () => void }) => [] as string[]),
);
// mock-isolation: reclamation scans host temp directories; prepare.test.ts runs it for real.
vi.mock("../commands/doctor-retained-runtime.js", () => ({
  prepareRetainedUpdateRuntimeMaintenance: async () => maintainRuntimes,
}));
// mock-isolation: preparation builds a real release; this test checks only the channel it is given.
vi.mock("./run.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./run.js")>()),
  prepareUpdate: async (params: unknown) => {
    prepared.push(params);
    return { status: "current", version: "2026.11.6", pluginsChanged: false };
  },
}));
vi.mock("../infra/update-run-write.async.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/update-run-write.async.js")>()),
  createUpdateRunAsync: createRun,
}));
vi.mock("../infra/update-run-reader.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/update-run-reader.js")>()),
  getUpdateRunAsync: async () => ({
    ...localRun,
    before: { version: "2026.11.8" },
    runId: "run-cli",
    reason: "already-current",
    steps: [],
    after: {},
  }),
}));
const runsGet = vi.hoisted(() => [] as Array<() => unknown>);
const useWireGateway = vi.hoisted(() => ({ enabled: false }));
vi.mock("../gateway/call.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../gateway/call.js")>()),
  callGateway: async (request: CallGatewayOptions) => {
    if (useWireGateway.enabled) {
      const actual = await importOriginal<typeof import("../gateway/call.js")>();
      return actual.callGateway(request);
    }
    if (request.method === "gateway.restart.request") {
      await request.prepareDispatchCurrent?.();
      sent.push(request);
      return { ok: true };
    }
    if (request.method === "update.run") {
      if (missingCredentials.enabled) {
        throw new GatewayCredentialsRequiredError({
          method: "update.run",
          configPath: "/tmp/openclaw-package/openclaw.json",
        });
      }
      request.onHelloOk?.({
        features: {
          capabilities: capabilities.shift()
            ? [GATEWAY_SERVER_CAPS.UPDATE_RUN_CONSENT_IDENTITY]
            : [],
        },
      } as Parameters<NonNullable<CallGatewayOptions["onHelloOk"]>>[0]);
      await request.prepareDispatchCurrent?.();
      request.assertDispatchCurrent?.();
      sent.push(structuredClone(request.params));
      return runsGet.length
        ? { runId: "run-1", ok: true }
        : { runId: null, ok: false, message: "refused for the test" };
    }
    if (request.method === "update.runs.get" && runsGet.length) {
      return runsGet.shift()!();
    }
    throw new Error(`unexpected ${request.method}`);
  },
}));

afterEach(async () => {
  vi.restoreAllMocks();
  await home.restore();
  capabilities.length = 0;
  install.kind = "git";
  missingCredentials.enabled = false;
  localRun.status = "skipped";
  localRun.phase = "finished";
  localRun.origin = {};
  maintainRuntimes.mockReset();
  maintainRuntimes.mockResolvedValue([]);
  confirmDowngrade.mockReset();
  createRun.mockClear();
  mutateConfig.mockClear();
  sent.length = 0;
  prepared.length = 0;
  runsGet.length = 0;
  useWireGateway.enabled = false;
  process.exitCode = undefined;
});

it("sends a pinned commit and the --timeout budget that the Gateway protocol accepts", async () => {
  const sha = "a".repeat(40);
  await expect(
    runReleaseUpdateCli({
      json: true,
      restart: true,
      runningRoot: root,
      sha,
      timeoutMs: 5_000,
    }),
  ).rejects.toThrow("refused for the test");
  // The Gateway gets what remains of the budget after this command's own work.
  expect(sent).toEqual([
    {
      target: { kind: "git", upstreamRef: "origin/main", upstreamSha: sha },
      timeoutMs: expect.any(Number),
    },
  ]);
  const { timeoutMs } = sent[0] as { timeoutMs: number };
  expect(timeoutMs).toBeGreaterThan(0);
  expect(timeoutMs).toBeLessThanOrEqual(5_000);
  expect(validateUpdateRunParams(sent[0])).toBe(true);
});

it("retires shared-state custody before dispatching an update to the Gateway", async () => {
  const events: string[] = [];
  vi.spyOn(stateDatabaseCache, "releaseOpenClawStateDatabaseCustody").mockImplementation(
    async () => {
      expect(sent).toEqual([]);
      events.push("released");
    },
  );
  runsGet.push(() => ({
    run: { status: "succeeded", steps: [], after: {}, origin: {} },
  }));
  await runReleaseUpdateCli({ json: true, restart: true, runningRoot: root });
  expect(events).toEqual(["released"]);
});

it("does not dispatch an update if shared-state custody cannot be released", async () => {
  vi.spyOn(stateDatabaseCache, "releaseOpenClawStateDatabaseCustody").mockRejectedValue(
    new Error("State custody could not be released"),
  );
  await expect(
    runReleaseUpdateCli({ json: true, restart: true, runningRoot: root }),
  ).rejects.toThrow("State custody could not be released");
  expect(sent).toEqual([]);
});

it("keeps a stable-tag checkout on stable when it updates without the Gateway", async () => {
  await runReleaseUpdateCli({ json: true, restart: false, runningRoot: root });
  expect(prepared).toEqual([expect.objectContaining({ channel: "stable" })]);
});

it("prepares this checkout itself instead of updating a remote Gateway", async () => {
  vi.stubEnv("OPENCLAW_GATEWAY_URL", "wss://remote.example.invalid");
  try {
    await runReleaseUpdateCli({ json: true, restart: true, runningRoot: root });
    expect(sent).toEqual([]);
    expect(prepared).toEqual([expect.objectContaining({ runningRoot: root })]);
  } finally {
    vi.unstubAllEnvs();
  }
});

it("keeps following the run while the restarting Gateway refuses connections", async () => {
  const { GatewayClientRequestError } = await import("../gateway/client.js");
  runsGet.push(
    () => {
      throw new GatewayClientRequestError({
        code: "UNAVAILABLE",
        retryable: true,
        message:
          "gateway rejected websocket upgrade (HTTP 503): Gateway websocket admission closed",
      });
    },
    () => ({
      run: {
        status: "succeeded",
        phase: "finished",
        steps: [],
        after: { version: "2.0.0" },
        origin: {},
      },
    }),
  );
  await runReleaseUpdateCli({ json: true, restart: true, runningRoot: root });
  expect(process.exitCode).toBe(0);
});

type WireRequest = {
  ws: WebSocket;
  id: string;
  method: string;
  params: ReturnType<typeof parseMinimalGatewayRequestFrame>["params"];
};

type WireRun = Pick<UpdateRunRecord, "runId" | "status" | "phase" | "steps" | "after" | "origin">;

async function withWireGateway(
  options: {
    restartMethod?: "update.run" | "gateway.restart.request";
    handleRequest?: (request: WireRequest) => boolean;
    supportsConsent?: () => boolean;
  },
  run: (peer: {
    tag: string | undefined;
    runId: string;
    output: WireRun;
    requests: string[];
    tokens: Array<string | undefined>;
    json: unknown[];
    tokenReads: () => number;
    releaseCustody: () => void;
  }) => Promise<void>,
) {
  const restartMethod = options.restartMethod ?? "update.run";
  useWireGateway.enabled = true;
  vi.spyOn(installationIdentity, "checkUpdateInstallationSlot").mockResolvedValue();
  const tag = restartMethod === "gateway.restart.request" ? VERSION : undefined;
  if (tag) {
    localRun.status = "running";
    localRun.phase = "activating";
  }
  const { claim, listener, releaseListener } = await reserveTestPortListener({
    offsets: [0],
    createListener: createServer,
  });
  const wss = new WebSocketServer({ server: listener });
  try {
    const configPath = path.join(home.home, "openclaw.json");
    vi.stubEnv("OPENCLAW_CONFIG_PATH", configPath);
    vi.stubEnv("OPENCLAW_GATEWAY_PORT", undefined);
    const refId = "GATEWAY_TEST_TOKEN";
    const token = "wire-test-token";
    await fs.writeFile(
      configPath,
      JSON.stringify({
        gateway: {
          port: claim.port,
          auth: { mode: "token", token: { source: "store", provider: "default", id: refId } },
        },
      }),
    );
    const runId = tag ? "run-cli" : "run-wire";
    const output: WireRun = {
      runId,
      status: "succeeded",
      phase: "finished",
      steps: [],
      after: {},
      origin: {},
    };
    const json: unknown[] = [];
    vi.spyOn(defaultRuntime, "writeJson").mockImplementation((record) => {
      json.push(record);
    });
    const requests: string[] = [];
    const tokens: Array<string | undefined> = [];
    let restartDispatched = false;
    let tokenReads = 0;
    vi.spyOn(resolveStore, "resolveStoreRefs").mockImplementation(async () => {
      tokenReads++;
      if (restartDispatched) {
        throw new Error("Restart has exclusive state custody");
      }
      return new Map([[refId, token]]);
    });
    wss.on("connection", (ws) => {
      ws.on("message", (data) => {
        const { id, method, params } = parseMinimalGatewayRequestFrame(data);
        if (!id || !method) {
          return;
        }
        if (method === "connect") {
          tokens.push(params?.auth?.token);
          const hello = buildMinimalGatewayHelloOkPayload();
          sendMinimalGatewayResponse(ws, id, {
            ...hello,
            features: {
              ...hello.features,
              capabilities: options.supportsConsent?.()
                ? [GATEWAY_SERVER_CAPS.UPDATE_RUN_CONSENT_IDENTITY]
                : [],
            },
          });
        } else {
          requests.push(method);
          if (method === restartMethod) {
            restartDispatched = true;
          }
          if (options.handleRequest?.({ ws, id, method, params })) {
            return;
          }
          if (method === restartMethod) {
            sendMinimalGatewayResponse(ws, id, { ok: true, runId });
          } else if (method === "update.runs.get") {
            sendMinimalGatewayResponse(ws, id, { run: params?.runId === runId ? output : null });
          }
        }
      });
      sendMinimalGatewayConnectChallenge(ws);
    });

    await run({
      tag,
      runId,
      output,
      requests,
      tokens,
      json,
      tokenReads: () => tokenReads,
      releaseCustody: () => {
        restartDispatched = false;
      },
    });
  } finally {
    vi.unstubAllEnvs();
    await closeMinimalGatewayServer(wss);
    await releaseListener();
    await claim.release();
  }
}

it.each(["update.run", "gateway.restart.request"] as const)(
  "follows %s without reading the Gateway token store after restart dispatch",
  async (restartMethod) => {
    await withWireGateway({ restartMethod }, async (peer) => {
      await runReleaseUpdateCli({
        json: true,
        restart: true,
        runningRoot: root,
        tag: peer.tag,
        yes: true,
      });
      expect(peer.requests).toEqual([restartMethod, "update.runs.get"]);
      expect(peer.tokens).toEqual(["wire-test-token", "wire-test-token"]);
      expect(peer.tokenReads()).toBe(1);
      expect(peer.json).toEqual([peer.output]);
      expect(process.exitCode).toBe(0);
    });
  },
);

it.for(["acknowledgement", "status", "poll delay"] as const)(
  "keeps the overall Gateway update budget during %s",
  async (scenario, { signal }) => {
    const heldRequest = createDeferred<WireRequest>();
    const heldClosed = createDeferred();
    const firstStatusClosed = createDeferred();
    let held: WireRequest | undefined;
    let statusRequests = 0;
    let running: WireRun;
    await withWireGateway(
      {
        handleRequest: (request) => {
          if (request.method === "update.runs.get") {
            statusRequests++;
            if (scenario === "status" && statusRequests === 1) {
              request.ws.once("close", () => firstStatusClosed.resolve());
              sendMinimalGatewayResponse(request.ws, request.id, { run: running });
              return true;
            }
          }
          if (
            (scenario === "acknowledgement" && request.method === "update.run") ||
            (scenario !== "acknowledgement" && request.method === "update.runs.get")
          ) {
            held = request;
            request.ws.once("close", () => heldClosed.resolve());
            heldRequest.resolve(request);
            return true;
          }
          return false;
        },
      },
      async (peer) => {
        running = { ...peer.output, status: "running", phase: "staging" };
        vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
        const deadline = Date.now() + 5_000;
        let outcome: { error?: unknown } | undefined;
        const command = runReleaseUpdateCli({
          json: true,
          restart: true,
          runningRoot: root,
          yes: true,
          timeoutMs: 5_000,
        });
        const settled = command.then(
          () => {
            outcome = {};
          },
          (error: unknown) => {
            outcome = { error };
          },
        );
        try {
          // Readiness owns timers before opening the real socket. Drive those
          // without consuming the budget we reserve for the withheld response.
          await waitForFast(() => expect(peer.requests).toContain("update.run"));
          if (scenario === "status") {
            await withinTest(
              awaitGateBeforeSettlement(
                firstStatusClosed.promise,
                command,
                "command settled before observing the running update",
              ),
              signal,
            );
            await nextEventLoopTurn();
            await vi.advanceTimersByTimeAsync(0);
            await vi.advanceTimersByTimeAsync(2_000);
          }
          await waitForFast(() => expect(held).toBeDefined());
          const request = await withinTest(
            awaitGateBeforeSettlement(
              heldRequest.promise,
              command,
              "command settled before the Gateway received its request",
            ),
            signal,
          );
          if (scenario === "poll delay") {
            await vi.advanceTimersByTimeAsync(Math.max(0, deadline - Date.now() - 1_000));
            sendMinimalGatewayResponse(request.ws, request.id, { run: running });
            await withinTest(heldClosed.promise, signal);
            await nextEventLoopTurn();
            await vi.advanceTimersByTimeAsync(0);
          }
          await vi.advanceTimersByTimeAsync(Math.max(0, deadline - Date.now()));
          await waitForFast(() => expect(outcome).toBeDefined(), { timeout: 100 });
          await settled;
          if (scenario === "acknowledgement") {
            expect(outcome?.error).toBeInstanceOf(Error);
            expect(String(outcome?.error)).toMatch(/did not finish|timeout/i);
            await withinTest(heldClosed.promise, signal);
          } else {
            expect(outcome).toEqual({});
            expect(peer.json).toEqual([running]);
            expect(process.exitCode).toBe(1);
          }
          expect(peer.requests).toEqual([
            "update.run",
            ...(scenario === "acknowledgement" ? [] : ["update.runs.get"]),
            ...(scenario === "status" ? ["update.runs.get"] : []),
          ]);
          expect(peer.tokenReads()).toBe(1);
          expect(createRun).not.toHaveBeenCalled();
          expect(prepared).toEqual([]);
        } finally {
          // Release the peer even when the pre-fix client is still waiting, then
          // join its command before the fixture closes sockets or restores the clock.
          if (held?.ws.readyState === WebSocket.OPEN) {
            sendMinimalGatewayResponse(
              held.ws,
              held.id,
              held.method === "update.run" ? { ok: true, runId: peer.runId } : { run: peer.output },
            );
          }
          await vi.advanceTimersByTimeAsync(30_000);
          await settled;
          vi.useRealTimers();
        }
      },
    );
  },
);

it.each([false, true])(
  "reclaims earlier updaters' runtimes itself before the Gateway updates (json=%s)",
  async (json) => {
    const removed = "Removed abandoned updater runtime: /tmp/openclaw-update-runtime-Gone01";
    maintainRuntimes.mockImplementation(async () => {
      // The Gateway's census would count this requesting command as a possible holder.
      expect(sent).toEqual([]);
      return [removed];
    });
    const log = vi.spyOn(defaultRuntime, "log").mockImplementation(() => {});
    const error = vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});
    const writeJson = vi.spyOn(defaultRuntime, "writeJson").mockImplementation(() => {});
    runsGet.push(() => ({
      run: {
        status: "succeeded",
        phase: "finished",
        steps: [],
        after: { version: "2026.11.7" },
        origin: {},
      },
    }));
    await runReleaseUpdateCli({ json, restart: true, runningRoot: root });
    expect(maintainRuntimes).toHaveBeenCalledOnce();
    const lines = (spy: typeof log) => spy.mock.calls.map(([line]) => line);
    if (json) {
      // stdout carries only the record.
      expect(lines(error)).toEqual([removed]);
      expect(log).not.toHaveBeenCalled();
      expect(writeJson).toHaveBeenCalledOnce();
    } else {
      expect(lines(log)).toEqual([removed, "finished: finished", "Updated to 2026.11.7."]);
      expect(error).not.toHaveBeenCalled();
    }
    expect(process.exitCode).toBe(0);
  },
);

it("skips cleanup under a short --timeout and gives the update the budget", async () => {
  await expect(
    runReleaseUpdateCli({ json: true, restart: true, runningRoot: root, timeoutMs: 5_000 }),
  ).rejects.toThrow("refused for the test");
  // A census cannot be interrupted, so a 5 s budget does not start one.
  expect(maintainRuntimes).not.toHaveBeenCalled();
  expect(sent).toEqual([{ timeoutMs: expect.any(Number) }]);
});

it("leaves kept-runtime lines to the cleanup owner's log", async () => {
  const removed = "Removed abandoned updater runtime: /tmp/openclaw-update-runtime-Gone01";
  maintainRuntimes.mockResolvedValue([
    removed,
    "Runtime retained at /tmp/openclaw-update-runtime-Held01: still in use",
  ]);
  const log = vi.spyOn(defaultRuntime, "log").mockImplementation(() => {});
  await runReleaseUpdateCli({ json: false, restart: false, runningRoot: root });
  expect(log.mock.calls.map(([line]) => line)).toEqual([removed, "Already up to date."]);
});

it("says the update is still running when the --timeout budget ends first", async () => {
  const error = vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});
  vi.spyOn(defaultRuntime, "log").mockImplementation(() => {});
  runsGet.push(() => ({
    run: { status: "running", phase: "staging", steps: [], after: {}, origin: {} },
  }));
  await runReleaseUpdateCli({
    json: false,
    restart: true,
    runningRoot: root,
    timeoutMs: 100,
  });
  expect(error.mock.calls.map(([message]) => message)).toEqual([
    "The update did not finish in time. Run `openclaw update status` to see it.",
  ]);
  expect(process.exitCode).toBe(1);
});

it.each([true, false])(
  "gates consent and checkout fields on the capability (%s)",
  async (supported) => {
    capabilities.push(supported);
    await expect(
      runReleaseUpdateCli({
        json: true,
        restart: true,
        runningRoot: root,
        acceptCapabilities: true,
      }),
    ).rejects.toThrow("refused for the test");
    expect(sent).toEqual([
      supported
        ? {
            checkout: { gitCommonDir: await fs.realpath(path.join(root, ".git")) },
            acceptCapabilities: true,
          }
        : {},
    ]);
  },
);

it.each([undefined, "beta"] as const)(
  "preserves a one-off package tag with saved channel %s",
  async (storedChannel) => {
    install.kind = "package";
    await runReleaseUpdateCli({
      json: true,
      restart: true,
      runningRoot: "/tmp/openclaw-package",
      tag: "2026.11.6",
      storedChannel,
      acceptCapabilities: true,
    });
    expect(sent).toEqual([]);
    expect(prepared).toEqual([
      expect.objectContaining({
        runningRoot: "/tmp/openclaw-package",
        channel: storedChannel ?? "stable",
        tag: "2026.11.6",
        acceptCapabilities: true,
      }),
    ]);
  },
);

it("updates an older Gateway before applying capability consent through its replacement", async () => {
  capabilities.push(false, true);
  runsGet.push(
    () => ({ run: { status: "succeeded", phase: "finished", steps: [], after: {}, origin: {} } }),
    () => ({ run: { status: "skipped", phase: "finished", steps: [], after: {}, origin: {} } }),
  );
  await runReleaseUpdateCli({
    json: true,
    restart: true,
    runningRoot: root,
    acceptCapabilities: true,
  });
  expect(sent).toEqual([
    {},
    {
      checkout: { gitCommonDir: await fs.realpath(path.join(root, ".git")) },
      acceptCapabilities: true,
    },
  ]);
  expect(prepared).toEqual([]);
  expect(process.exitCode).toBe(0);
});

it("does not claim consent was applied when the replacement Gateway still lacks support", async () => {
  capabilities.push(false, false);
  runsGet.push(() => ({
    run: {
      status: "succeeded",
      phase: "finished",
      steps: [],
      after: {},
      origin: {
        nextAction: "Run `node /installation-a/openclaw.mjs update --accept-capabilities`.",
      },
    },
  }));
  await expect(
    runReleaseUpdateCli({
      json: true,
      restart: true,
      runningRoot: root,
      acceptCapabilities: true,
    }),
  ).rejects.toThrow(
    "Capability consent was not applied because the updated Gateway does not support it. Run `node /installation-a/openclaw.mjs update --accept-capabilities`.",
  );
  expect(sent).toEqual([{}]);
  expect(prepared).toEqual([]);
});

it("refuses --no-restart from another checkout before preparation or creating a trial", async () => {
  const installed = path.join(home.home, "installation-a");
  await fs.mkdir(installed);
  await runCommandWithTimeout(["git", "init", installed], { timeoutMs: 10_000 });
  await fs.mkdir(resolvePrefix(), { recursive: true });
  await switchLink(installed);
  await expect(
    runReleaseUpdateCli({ json: true, restart: false, runningRoot: root }),
  ).rejects.toThrow(`Nothing changed. To update that installation, run:`);
  expect(await fs.realpath(path.join(resolvePrefix(), "openclaw"))).toBe(
    await fs.realpath(installed),
  );
  await expect(fs.stat(path.join(resolvePrefix(), "releases", ".trial"))).rejects.toThrow();
  expect(prepared).toEqual([]);
  expect(maintainRuntimes).not.toHaveBeenCalled();
});

it("lets an accessible Gateway take over an opaque first-conversion owner", async () => {
  vi.spyOn(installationIdentity, "checkUpdateInstallationSlot").mockRejectedValueOnce(
    new installationIdentity.UnverifiedForegroundUpdateOwnerError(123),
  );
  runsGet.push(() => ({
    run: { status: "succeeded", phase: "finished", steps: [], after: {}, origin: {} },
  }));
  await runReleaseUpdateCli({ json: true, restart: true, runningRoot: root });
  expect(sent).toEqual([{}]);
  expect(prepared).toEqual([]);
});

it.each([{ restart: false }, { restart: true, tag: "beta" }])(
  "refuses opaque foreground ownership when RPC cannot carry the update: %j",
  async (opts) => {
    vi.spyOn(installationIdentity, "checkUpdateInstallationSlot").mockRejectedValueOnce(
      new installationIdentity.UnverifiedForegroundUpdateOwnerError(123),
    );
    await expect(runReleaseUpdateCli({ json: true, runningRoot: root, ...opts })).rejects.toThrow(
      "operator access",
    );
    expect(sent).toEqual([]);
    expect(prepared).toEqual([]);
    expect(createRun).not.toHaveBeenCalled();
    expect(maintainRuntimes).not.toHaveBeenCalled();
  },
);

it("restarts the local Gateway after preparing an explicit package tag and follows its outcome", async () => {
  install.kind = "package";
  localRun.status = "running";
  localRun.phase = "activating";
  const releaseAdmission = {
    owner: "candidate",
    candidateVersion: "2026.11.6",
    verdict: "admit",
    warnings: [{ code: "configured-plugin-path-unavailable", message: "Plugin path is absent" }],
  } satisfies NonNullable<UpdateRunRecord["origin"]["releaseAdmission"]>;
  localRun.origin.releaseAdmission = releaseAdmission;
  const json = vi.spyOn(defaultRuntime, "writeJson").mockImplementation(() => {});
  runsGet.push(() => ({
    run: {
      runId: "run-cli",
      status: "succeeded",
      phase: "finished",
      steps: [],
      after: { version: "2026.11.6" },
      origin: {},
    },
  }));
  await runReleaseUpdateCli({
    json: true,
    restart: true,
    runningRoot: "/tmp/openclaw-package",
    tag: "2026.11.6",
  });
  expect(sent).toEqual([
    expect.objectContaining({
      method: "gateway.restart.request",
      params: { reason: "update.run" },
    }),
  ]);
  expect(process.exitCode).toBe(0);
  expect(json).toHaveBeenCalledWith(
    expect.objectContaining({
      status: "succeeded",
      after: { version: "2026.11.6" },
      origin: { releaseAdmission },
    }),
  );
});

it.each([
  { yes: false, decision: "confirmation-required", code: 1 },
  { yes: false, decision: "cancelled", code: 0 },
  { yes: true, decision: "confirmed", code: 0 },
] as const)(
  "requires downgrade consent before admission (yes=$yes, decision=$decision)",
  async ({ yes, decision, code }) => {
    install.kind = "package";
    packageTarget.version = "2000.1.1";
    confirmDowngrade.mockResolvedValueOnce(decision);
    const json = vi.spyOn(defaultRuntime, "writeJson").mockImplementation(() => {});
    await runReleaseUpdateCli({
      json: true,
      restart: false,
      runningRoot: "/tmp/openclaw-package",
      channel: "beta",
      yes,
    });
    expect(process.exitCode).toBe(code);
    if (yes) {
      expect(confirmDowngrade).not.toHaveBeenCalled();
      expect(prepared).toHaveLength(1);
    } else {
      expect(createRun).not.toHaveBeenCalled();
      expect(mutateConfig).not.toHaveBeenCalled();
      expect(prepared).toEqual([]);
      expect(json).toHaveBeenCalledWith({
        status: "skipped",
        reason: decision === "cancelled" ? "cancelled" : "downgrade-confirmation-required",
      });
    }
  },
);

it("prepares locally when the local Gateway has no usable credentials", async () => {
  missingCredentials.enabled = true;
  install.kind = "package";
  await runReleaseUpdateCli({
    json: true,
    restart: true,
    runningRoot: root,
    yes: true,
  });
  expect(prepared).toEqual([expect.objectContaining({ runningRoot: root })]);
  expect(process.exitCode).toBe(0);
});

it.each([
  { version: "2026.11.10", target: true, action: undefined, pending: false },
  { version: "2026.11.7", target: false, action: undefined, pending: false },
  { version: "2026.11.10", target: true, action: "restart", pending: false },
  { version: "2026.11.10", target: false, action: "start", pending: true },
] as const)(
  "lets the resident update from npm $version without an implicit downgrade ($action, pending=$pending)",
  async ({ version, target, action, pending }) => {
    const npmPrefix = path.join(home.home, "npm");
    const frontend = path.join(
      npmPrefix,
      ...(process.platform === "win32" ? [] : ["lib"]),
      "node_modules",
      "openclaw",
    );
    const npmBin = process.platform === "win32" ? npmPrefix : path.join(npmPrefix, "bin");
    const resident = path.join(resolvePrefix(), "releases", "resident", "openclaw");
    await fs.mkdir(frontend, { recursive: true });
    await fs.mkdir(resident, { recursive: true });
    await fs.mkdir(npmBin, { recursive: true });
    await fs.writeFile(path.join(npmBin, process.platform === "win32" ? "npm.cmd" : "npm"), "");
    await fs.writeFile(
      path.join(frontend, "package.json"),
      JSON.stringify({ name: "openclaw", version }),
    );
    await fs.writeFile(
      path.join(resident, "package.json"),
      JSON.stringify({ name: "openclaw", version: "2026.11.8" }),
    );
    await switchLink(resident);
    const receipt = path.join(home.home, "resident-update.json");
    await fs.writeFile(
      path.join(resolvePrefix(), "openclaw-launcher.mjs"),
      `import fs from "node:fs"; fs.writeFileSync(${JSON.stringify(receipt)}, JSON.stringify(process.argv.slice(2))); if (process.argv.includes("--json")) console.log(JSON.stringify({status:"running",runId:"fixture",phase:"activating"}));`,
    );
    const log = vi.spyOn(defaultRuntime, "log").mockImplementation(() => {});
    if (pending) {
      await createTrialPending({
        runId: "prepared-without-forwarding",
        target: "releases/prepared/openclaw",
        previous: resident,
        version,
      });
    }
    if (action) {
      vi.spyOn(openclawRoot, "resolveOpenClawPackageRoot").mockResolvedValue(frontend);
      const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      expect(await tryAdoptInstalledPackageForGateway({ json: true, action })).toBe(
        pending ? "prepared-without-forwarding" : undefined,
      );
      expect(stdout).not.toHaveBeenCalled();
    } else {
      await runReleaseUpdateCli({ json: false, restart: true, runningRoot: frontend });
    }
    if (pending) {
      await expect(fs.stat(receipt)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(fs.stat(path.join(frontend, ".openclaw-launcher"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      return;
    }
    const args: string[] = JSON.parse(await fs.readFile(receipt, "utf8"));
    expect(args).toEqual([
      "update",
      ...(target ? ["--tag", `file:${frontend}`] : []),
      ...(action ? ["--json", "--no-restart"] : []),
    ]);
    expect(prepared).toEqual([]);
    expect(sent).toEqual([]);
    expect(process.exitCode).toBe(0);
    if (!target) {
      expect(log).toHaveBeenCalledWith(expect.stringContaining("It was not downgraded"));
      expect(log).toHaveBeenCalledWith(expect.stringContaining(`openclaw update --tag ${version}`));
      expect(await fs.readFile(path.join(frontend, ".openclaw-launcher"), "utf8")).toBe(
        `${path.join(resolvePrefix(), "openclaw-launcher.mjs")}\n`,
      );
    }
  },
);

it.each([
  { phase: "committed", status: "succeeded", expected: undefined },
  {
    phase: "rolled-back",
    status: "rolled-back",
    expected: "Update failed: Candidate crashed after migration.",
  },
] as const)(
  "settles adopted $phase trials without opening the ledger or RPC",
  async ({ phase, status, expected }) => {
    const trial = await createTrialPending({
      runId: "adopted-run",
      target: "releases/new/openclaw",
      previous: "releases/old/openclaw",
      version: "2026.11.10",
    });
    await writeTrial({
      ...trial,
      phase,
      outcome: { status, reason: "Candidate crashed after migration.", at: Date.now() },
    });
    const readRun = vi.spyOn(updateRunReader, "getUpdateRunAsync");
    runsGet.push(() => {
      throw new Error("An adoption waiter must not call the Gateway");
    });
    expect(await waitForReleaseUpdateFailure()).toBe(expected);
    expect(readRun).not.toHaveBeenCalled();
    expect(runsGet).toHaveLength(1);
  },
);

it("reports when the sole prepared trial is no longer available", async () => {
  expect(await waitForReleaseUpdateFailure()).toBe(
    "The update trial is no longer available. Run `openclaw update status` to see the result.",
  );
});

it.each(["pending", "trial", "restoring"] as const)(
  "bounds an adopted restart waiting on a %s trial",
  async (phase) => {
    const trial = await createTrialPending({
      runId: "adopted-run",
      target: "releases/new/openclaw",
      previous: "releases/old/openclaw",
      version: "2026.11.10",
    });
    const now = Date.now();
    await writeTrial({ ...trial, phase, createdAt: now - TRIAL_BUDGET_MS - 1 });
    vi.spyOn(Date, "now")
      .mockReturnValueOnce(now)
      .mockReturnValue(now + TRIAL_BUDGET_MS);
    expect(await waitForReleaseUpdateFailure()).toBe(
      "The update did not finish in time. Run `openclaw update status` to see it.",
    );
  },
);

it("waits for activation of an old pending trial instead of expiring its preparation clock", async () => {
  const trial = await createTrialPending({
    runId: "delayed-adoption",
    target: "releases/new/openclaw",
    previous: "releases/old/openclaw",
    version: "2026.11.10",
  });
  const readTrial = vi
    .spyOn(releaseStore, "readTrial")
    .mockResolvedValueOnce({ ...trial, createdAt: Date.now() - 2 * TRIAL_BUDGET_MS })
    .mockResolvedValue({ ...trial, phase: "committed" });
  expect(await waitForReleaseUpdateFailure()).toBeUndefined();
  expect(readTrial).toHaveBeenCalledTimes(2);
});
