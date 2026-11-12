import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveLaunchAgentLabel } from "../daemon/launchd-label.js";
import { resolveLaunchAgentEnvWrapperPath } from "../daemon/launchd-service-files.js";
import { resolveGatewayTaskScriptPath } from "../daemon/paths.js";
import type { GatewayService, GatewayServiceInstallArgs } from "../daemon/service-types.js";
import type { PackageUpdateTransaction } from "../infra/package-update-swap-contract.js";
import { resolveNpmGlobalPrefixLayoutFromPrefix } from "../infra/update-npm-prefix.js";
import { buildGatewayInstallPlan } from "./daemon-install-helpers.js";
import { prepareGatewayServiceInstall } from "./gateway-service-setup.js";

const mocks = vi.hoisted(() => ({
  resolvePreferredBunPath: vi.fn(),
  runGlobalPackageUpdateSteps: vi.fn(),
}));

// The fake keeps the updater's activation hooks and transaction, so install ordering, restore
// and retirement stay observable.
// mock-isolation: npm staging is the package updater's own contract and must not run here.
vi.mock("../infra/package-update-steps.js", () => ({
  runGlobalPackageUpdateSteps: mocks.runGlobalPackageUpdateSteps,
}));

// mock-isolation: no npm prefix probe may spawn on the test host.
vi.mock("../infra/update-global.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/update-global.js")>()),
  resolveGlobalInstallTarget: async () => ({ manager: "npm", command: "npm" }),
}));

// mock-isolation: runtime discovery must not probe the test host's Node or Bun.
vi.mock("../daemon/runtime-paths.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../daemon/runtime-paths.js")>()),
  resolvePreferredBunPath: mocks.resolvePreferredBunPath,
  resolvePreferredNodePath: async () => "/opt/node/bin/node",
  resolveSystemNodeInfo: async () => ({
    path: "/opt/node/bin/node",
    version: "24.22.1",
    status: "supported",
  }),
}));

// mock-isolation: service-env planning must not read operator secrets from the host auth store.
vi.mock("./daemon-install-auth-profiles-source.runtime.js", () => ({
  hasAnyAuthProfileStoreSourceAsync: async () => false,
}));

afterEach(() => vi.resetAllMocks());

const writePackageFiles = (root: string, files = ["openclaw.mjs", "dist/index.js"]) => {
  for (const file of files) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), "");
  }
};

describe("Gateway service planned from a disposable npx CLI", () => {
  const events: string[] = [];
  let stagedFiles: string[] | undefined;
  let root: string;
  let argv: string[];
  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "oc-durable-plan-")));
    const npxPackage = path.join(root, ".npm", "_npx", "abc", "node_modules", "openclaw");
    fs.mkdirSync(npxPackage, { recursive: true });
    fs.writeFileSync(
      path.join(npxPackage, "package.json"),
      '{"name":"openclaw","version":"1.2.3"}',
    );
    writePackageFiles(npxPackage);
    argv = process.argv;
    process.argv = ["node", path.join(npxPackage, "openclaw.mjs"), "gateway", "install"];
    events.length = 0;
    stagedFiles = undefined;
    // Stage and validate first, wait at the activation gate, then register the swap transaction.
    mocks.runGlobalPackageUpdateSteps.mockImplementation(
      async (params: {
        validateCandidate?: (root: string) => Promise<Array<{ exitCode: number | null }>>;
        beforeActivate?: () => Promise<void>;
        onTransaction?: (transaction: PackageUpdateTransaction) => Promise<void> | void;
      }) => {
        const candidate = path.join(root, "stage", "openclaw");
        writePackageFiles(candidate, stagedFiles);
        events.push("staged");
        const rejected = (await params.validateCandidate?.(candidate))?.find(
          (step) => step.exitCode !== 0,
        );
        if (rejected) {
          return { steps: [rejected], failedStep: rejected };
        }
        await params.beforeActivate?.();
        await params.onTransaction?.({
          backupRoot: path.join(root, "backup"),
          rollback: async () => {
            events.push("restored");
            return {
              name: "package-rollback",
              command: "",
              cwd: root,
              durationMs: 0,
              exitCode: 0,
              activePackageRoot: null,
            };
          },
          complete: async ({ activationVerified }) => {
            events.push(activationVerified ? "backup-retired" : "backup-settled-unverified");
          },
        });
        events.push("swapped");
        return {
          steps: [],
          activePackageRoot: null,
          afterVersion: "1.2.3",
          failedStep: null,
          recovery: { serviceRestartSafe: true, version: "1.2.3" },
        };
      },
    );
  });
  afterEach(() => {
    process.argv = argv;
    fs.rmSync(root, { recursive: true, force: true });
  });
  const env = (extra: Record<string, string> = {}) => ({
    HOME: root,
    OPENCLAW_STATE_DIR: path.join(root, "state"),
    ...extra,
  });
  const durableLayout = () =>
    resolveNpmGlobalPrefixLayoutFromPrefix(path.join(root, "state", "npm"));
  const durableEntrypoint = () => path.join(durableLayout().globalRoot, "openclaw", "openclaw.mjs");
  // The real argument builder picks the package's dist entry; the durable copy gets the same one.
  const durableRuntimeEntry = () =>
    path.join(durableLayout().globalRoot, "openclaw", "dist", "index.js");
  const installedArguments = (gateway: GatewayService) =>
    vi.mocked(gateway.install).mock.calls[0]?.[0].programArguments;
  const olderCopy = () => {
    const durablePackage = path.dirname(durableEntrypoint());
    fs.mkdirSync(durablePackage, { recursive: true });
    fs.writeFileSync(
      path.join(durablePackage, "package.json"),
      '{"name":"openclaw","version":"1.0.0"}',
    );
    fs.writeFileSync(durableEntrypoint(), "");
  };
  const service = (failure?: "refused" | "recovered" | "write-failed" | "not-loaded") =>
    ({
      install: vi.fn(async (args: GatewayServiceInstallArgs) => {
        events.push("service-admitted");
        if (failure === "refused") {
          throw new Error("service refused");
        }
        await args.beforeMutation?.();
        events.push("definition-written");
        if (failure === "recovered") {
          // Native recovery stopped the replacement and is about to restart the previous one.
          await args.beforeRecovery?.();
          throw new Error("service write failed");
        }
        if (failure === "write-failed") {
          throw new Error("service write failed");
        }
      }),
      isLoaded: vi.fn(async () => failure !== "not-loaded"),
    }) as unknown as GatewayService;
  const prepare = (gateway: GatewayService, runtime: "node" | "bun" = "node") =>
    prepareGatewayServiceInstall({
      service: gateway,
      selection: {
        runtime,
        runtimeExplicit: runtime === "bun",
        runtimePath: undefined,
        pinnedRuntimePath: undefined,
        runtimePinUpdate: { expected: { revision: "empty", stored: false }, pin: undefined },
        env: { ...env(), OPENCLAW_WRAPPER: undefined },
      },
      existingCommand: null,
      config: {},
      port: 3000,
      warn: vi.fn(),
    });

  it("selects the runtime before staging a replacement for the copy a service runs", async () => {
    olderCopy();
    mocks.resolvePreferredBunPath.mockRejectedValue(new Error("No supported Bun runtime found."));

    await expect(prepare(service(), "bun")).rejects.toThrow("No supported Bun runtime found.");
    expect(mocks.runGlobalPackageUpdateSteps).not.toHaveBeenCalled();
  });

  it.each([
    [
      "darwin",
      (e: Record<string, string>) =>
        resolveLaunchAgentEnvWrapperPath(e, resolveLaunchAgentLabel(e)),
    ],
    ["win32", (e: Record<string, string>) => resolveGatewayTaskScriptPath(e)],
  ] as const)(
    "plans the durable copy when %s clears the generated wrapper",
    async (platform, generatedWrapper) => {
      const plan = await buildGatewayInstallPlan({
        env: env({ OPENCLAW_WRAPPER: generatedWrapper(env()) }),
        port: 3000,
        runtime: "node",
        platform,
        installDurableCli: true,
      });

      expect(plan.programArguments).toContain(durableRuntimeEntry());
      expect(plan.environment.OPENCLAW_WRAPPER).toBeUndefined();
      // Planning only decides; the replacement waits for the service install.
      expect(plan.durableCliReplacement).toMatchObject({ version: "1.2.3" });
      expect(mocks.runGlobalPackageUpdateSteps).not.toHaveBeenCalled();
      // A LaunchAgent gets the launcher folder on PATH before the copy exists; tasks set none.
      if (platform === "darwin") {
        expect(plan.environment.PATH?.split(":")).toContain(durableLayout().binDir);
      }
    },
  );

  it.each([
    ["retires the backup once the service is verified loaded", undefined, "backup-retired"],
    [
      "keeps the backup while the service is not verified loaded",
      "not-loaded",
      "backup-settled-unverified",
    ],
  ] as const)(
    "swaps the copy inside the service install and %s",
    async (_name, failure, settled) => {
      olderCopy();
      const gateway = service(failure);
      const installation = await prepare(gateway);
      expect(events).toEqual([]);

      await installation.install();

      expect(installedArguments(gateway)).toContain(durableRuntimeEntry());
      expect(events).toEqual([
        "staged",
        "service-admitted",
        "swapped",
        "definition-written",
        settled,
      ]);
    },
  );

  it("refuses a staged copy without the entry the service will run, before the service", async () => {
    stagedFiles = ["openclaw.mjs"];
    const gateway = service();
    const installation = await prepare(gateway);

    await expect(installation.install()).rejects.toThrow(/dist[/\\]index\.js/u);
    expect(events).toEqual(["staged"]);
    expect(gateway.install).not.toHaveBeenCalled();
  });

  it.each([
    ["refuses before its mutation hook", "refused", true, ["staged", "service-admitted"]],
    [
      "fails and its recovery settles after replacing an older copy",
      "recovered",
      true,
      ["staged", "service-admitted", "swapped", "definition-written", "restored", "backup-retired"],
    ],
    [
      "fails without a settled recovery, which keeps the new copy and backup",
      "write-failed",
      true,
      ["staged", "service-admitted", "swapped", "definition-written", "backup-settled-unverified"],
    ],
    [
      "fails after a first install, which keeps its new copy",
      "recovered",
      false,
      ["staged", "service-admitted", "swapped", "definition-written", "backup-retired"],
    ],
  ] as const)(
    "settles the durable copy when the service install %s",
    async (_name, failure, existing, expected) => {
      if (existing) {
        olderCopy();
      }
      const installation = await prepare(service(failure));

      await expect(installation.install()).rejects.toThrow(/service (refused|write failed)/u);
      expect(events).toEqual(expected);
    },
  );
});
