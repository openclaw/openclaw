import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { validateUpdateRunParams } from "../../packages/gateway-protocol/src/index.js";
import { GATEWAY_SERVER_CAPS } from "../../packages/gateway-protocol/src/server-capabilities.js";
import type * as UpdateCliShared from "../cli/update-cli/shared.js";
import type * as ConfigMutate from "../config/mutate.js";
import { GatewayCredentialsRequiredError } from "../gateway/call-device-auth.js";
import type { CallGatewayOptions } from "../gateway/call-options.js";
import { runCommandWithTimeout } from "../process/exec.js";
import { defaultRuntime } from "../runtime.js";
import { createTempHomeEnv, type TempHomeEnv } from "../test-utils/temp-home.js";
import { VERSION } from "../version.js";
import { runReleaseUpdateCli } from "./cli.js";
import { resolvePrefix, switchLink } from "./store.js";
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
const localRun = vi.hoisted(() => ({ status: "skipped", phase: "finished" }));
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
    runId: "run-cli",
    reason: "already-current",
    steps: [],
    after: {},
    origin: {},
  }),
}));
const runsGet = vi.hoisted(() => [] as Array<() => unknown>);
vi.mock("../gateway/call.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../gateway/call.js")>()),
  callGateway: async (request: CallGatewayOptions) => {
    if (request.method === "gateway.restart.request") {
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
  maintainRuntimes.mockReset();
  maintainRuntimes.mockResolvedValue([]);
  confirmDowngrade.mockReset();
  createRun.mockClear();
  mutateConfig.mockClear();
  sent.length = 0;
  prepared.length = 0;
  runsGet.length = 0;
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

it("restarts the local Gateway after preparing an explicit package tag and follows its outcome", async () => {
  install.kind = "package";
  localRun.status = "running";
  localRun.phase = "activating";
  runsGet.push(() => ({
    run: { status: "succeeded", phase: "finished", steps: [], after: {}, origin: {} },
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
