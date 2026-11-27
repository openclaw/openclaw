import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { validateUpdateRunParams } from "../../packages/gateway-protocol/src/index.js";
import { GATEWAY_SERVER_CAPS } from "../../packages/gateway-protocol/src/server-capabilities.js";
import type * as UpdateCliShared from "../cli/update-cli/shared.js";
import type * as ConfigMutate from "../config/mutate.js";
import { GatewayCredentialsRequiredError } from "../gateway/call-device-auth.js";
import type { CallGatewayOptions } from "../gateway/call-options.js";
import * as openclawRoot from "../infra/openclaw-root.js";
import * as updateRunReader from "../infra/update-run-reader.js";
import type { UpdateRunRecord } from "../infra/update-run-record.js";
import { createUpdateRunRecordFixture } from "../infra/update-run-record.test-support.js";
import { runCommandWithTimeout } from "../process/exec.js";
import { defaultRuntime } from "../runtime.js";
import * as stateDatabaseCache from "../state/openclaw-state-db-cache.js";
import { createTempHomeEnv, type TempHomeEnv } from "../test-utils/temp-home.js";
import { VERSION } from "../version.js";
import { registerReleaseUpdateGatewayTests } from "./cli.gateway.test-support.js";
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
const gatewayRunId = vi.hoisted(() => "e901d247-3929-4f73-94ef-0e54efbcfb73");
const createRun = vi.hoisted(() => vi.fn(async () => ({ runId: gatewayRunId })));
const mutateConfig = vi.hoisted(() => vi.fn());
// Keep ordinary promise timers real; the polling case installs its controlled wait.
vi.mock("node:timers/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:timers/promises")>();
  return { ...original, setTimeout: vi.fn(original.setTimeout) };
});
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
const prepareReply = vi.hoisted(() =>
  vi.fn(async () => ({ status: "current" as const, version: "2026.11.6", pluginsChanged: false })),
);
// mock-isolation: preparation builds a real release; this test checks only the channel it is given.
vi.mock("./run.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./run.js")>()),
  prepareUpdate: async (params: unknown) => {
    prepared.push(params);
    return prepareReply();
  },
}));
vi.mock("../infra/update-run-write.async.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/update-run-write.async.js")>()),
  createUpdateRunAsync: createRun,
}));
vi.mock("../infra/update-run-reader.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/update-run-reader.js")>()),
  getUpdateRunAsync: async () =>
    createUpdateRunRecordFixture("run-cli", {
      ...localRun,
      before: { version: "2026.11.8" },
      reason: "already-current",
    }),
}));
const runsGet = vi.hoisted(() => [] as Array<() => { run: Partial<UpdateRunRecord> | null }>);
const restartReply = vi.hoisted(() => vi.fn(async () => ({ ok: true })));
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
      return restartReply();
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
        ? { runId: gatewayRunId, ok: true }
        : { runId: null, ok: false, message: "refused for the test" };
    }
    if (request.method === "update.runs.get" && runsGet.length) {
      const { run } = runsGet.shift()!();
      return { run: run ? createUpdateRunRecordFixture(gatewayRunId, run) : null };
    }
    throw new Error(`unexpected ${request.method}`);
  },
}));

afterEach(async () => {
  // Wire fixtures restore their clock before closing their peers.
  if (!useWireGateway.enabled) {
    vi.useRealTimers();
  }
  vi.restoreAllMocks();
  await home.restore();
  capabilities.length = 0;
  install.kind = "git";
  missingCredentials.enabled = false;
  localRun.status = "skipped";
  localRun.phase = "finished";
  localRun.origin = {};

  confirmDowngrade.mockReset();
  createRun.mockClear();
  mutateConfig.mockClear();
  sent.length = 0;
  prepared.length = 0;
  prepareReply.mockReset();
  runsGet.length = 0;
  restartReply.mockReset();
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

registerReleaseUpdateGatewayTests(() => ({
  home,
  root,
  localRun,
  useWireGateway,
  createRun,
  prepared,
}));

it.each(["status", "restart"] as const)(
  "keeps the %s result when RPC cleanup settles after expiry",
  async (method) => {
    const json = vi.spyOn(defaultRuntime, "writeJson").mockImplementation(() => {});
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const deadline = Date.now() + 5_000;
    const record = createUpdateRunRecordFixture(gatewayRunId, { status: "succeeded" });
    if (method === "status") {
      runsGet.push(() => {
        // A captured response survives the RPC owner's joined cleanup.
        vi.setSystemTime(deadline + 1);
        return { run: record };
      });
    } else {
      localRun.status = "running";
      localRun.phase = "activating";
      localRun.origin.releaseAdmission = {
        owner: "candidate",
        candidateVersion: VERSION,
        verdict: "admit",
        warnings: [],
      };
      restartReply.mockImplementationOnce(async () => {
        vi.setSystemTime(deadline + 1);
        return { ok: true };
      });
    }
    await runReleaseUpdateCli({
      json: true,
      restart: true,
      runningRoot: root,
      yes: true,
      tag: method === "restart" ? VERSION : undefined,
      timeoutMs: 5_000,
    });
    expect(json).toHaveBeenCalledWith(
      method === "status"
        ? record
        : expect.objectContaining({
            status: "running",
            phase: "activating",
            origin: localRun.origin,
          }),
    );
    expect(sent).toHaveLength(1);
    expect(process.exitCode).toBe(0);
  },
);

it("distinguishes completed plugin maintenance from an unconfirmed restart at expiry", async () => {
  const json = vi.spyOn(defaultRuntime, "writeJson").mockImplementation(() => {});
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  const deadline = Date.now() + 5_000;
  prepareReply.mockImplementationOnce(async () => {
    vi.setSystemTime(deadline);
    return { status: "current", version: VERSION, pluginsChanged: true };
  });
  await expect(
    runReleaseUpdateCli({
      json: true,
      restart: true,
      runningRoot: root,
      yes: true,
      tag: VERSION,
      timeoutMs: 5_000,
    }),
  ).rejects.toThrow("Plugin maintenance completed, but the Gateway restart could not be confirmed");
  expect(sent).toEqual([]);
  expect(json).not.toHaveBeenCalled();
  expect(prepared).toHaveLength(1);
});

it("gives a short --timeout budget to the update request", async () => {
  await expect(
    runReleaseUpdateCli({ json: true, restart: true, runningRoot: root, timeoutMs: 5_000 }),
  ).rejects.toThrow("refused for the test");
  expect(sent).toEqual([{ timeoutMs: expect.any(Number) }]);
});

it("says the update is still running when the --timeout budget ends first", async () => {
  const error = vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});
  vi.spyOn(defaultRuntime, "log").mockImplementation(() => {});
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  const deadline = Date.now() + 100;
  runsGet.push(() => {
    // Reporting requires an observed running record; filesystem setup must not
    // decide whether this unit control reaches that boundary.
    vi.setSystemTime(deadline);
    return { run: { status: "running", phase: "staging", steps: [], after: {}, origin: {} } };
  });
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
      runId: gatewayRunId,
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
