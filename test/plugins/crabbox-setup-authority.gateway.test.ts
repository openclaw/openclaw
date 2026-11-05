import fs from "node:fs/promises";
import path from "node:path";
import { inspect as inspectError } from "node:util";
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import {
  createCrabboxProvisionAuthority,
  parseCrabboxProfile,
  runProvisionSetup,
  stopCrabboxLease,
} from "../../extensions/crabbox/test-api.js";
import * as projectPreparation from "../../src/gateway/worker-environments/project-preparation.js";
import {
  beforeSettlement,
  create,
  providerService,
  repository,
} from "../../src/gateway/worker-environments/provider-lifecycle.test-support.js";
import * as support from "../../src/gateway/worker-environments/service.test-support.js";
import type { WorkerProvider } from "../../src/plugins/capability-provider.types.js";
import { createDeferredCore } from "../../src/shared/deferred.js";
import { createSetupCommandFixture } from "./crabbox-setup-authority.test-support.js";

const ioHook = vi.hoisted((): { afterProfileWrite?: (file: string) => Promise<void> } => ({}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const paths = await import("node:path");
  const writeFile: typeof actual.writeFile = async (...args) => {
    await actual.writeFile(...args);
    const file = args[0];
    if (
      typeof file === "string" &&
      paths.basename(file) === "setup.env" &&
      paths.basename(paths.dirname(file)).startsWith("openclaw-crabbox-env-")
    ) {
      await ioHook.afterProfileWrite?.(file);
    }
  };
  // Preserve all exports. Only the completion of the actual private profile write is gated.
  return { ...actual, writeFile };
});

const createProjectOwner = projectPreparation.createWorkerProjectPreparation;

type Options = NonNullable<Parameters<WorkerProvider["provision"]>[2]>;
type ProjectOwner = ReturnType<typeof projectPreparation.createWorkerProjectPreparation>;
type Scenario = {
  name: string;
  phase: "node runtime preparation" | "node enrollment setup";
  point: "profile" | "retry";
  revoke?: "host" | "project";
  runs: number;
  failSetup?: boolean;
};

const scenarios: Scenario[] = [
  { name: "runtime allowed", phase: "node runtime preparation", point: "profile", runs: 1 },
  { name: "enrollment allowed", phase: "node enrollment setup", point: "profile", runs: 1 },
  {
    name: "host revoked during runtime profile write",
    phase: "node runtime preparation",
    point: "profile",
    revoke: "host",
    runs: 0,
  },
  {
    name: "project closed during enrollment profile write",
    phase: "node enrollment setup",
    point: "profile",
    revoke: "project",
    runs: 0,
  },
  { name: "coordinator retry allowed", phase: "node enrollment setup", point: "retry", runs: 2 },
  {
    name: "host revoked before coordinator retry",
    phase: "node enrollment setup",
    point: "retry",
    revoke: "host",
    runs: 1,
  },
  {
    name: "project closed before coordinator retry",
    phase: "node enrollment setup",
    point: "retry",
    revoke: "project",
    runs: 1,
  },
  {
    name: "owned cleanup after setup failure",
    phase: "node runtime preparation",
    point: "profile",
    runs: 1,
    failSetup: true,
  },
];

describe("Gateway-owned Crabbox setup final effects", () => {
  support.setupWorkerEnvironmentServiceSuite((config) => {
    expectDefined(config.cloudWorkers?.profiles?.development, "fixture profile").settings = {
      provider: "azure-sandbox",
      ttl: "1h",
      idleTimeout: "10m",
    };
  });

  it.each(scenarios)("$name", async (scenario) => {
    const repo = await repository("project", { disableSigning: true });
    const cli = await createSetupCommandFixture(support.testState.root, scenario.point === "retry");
    const originalHome = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
    process.env.HOME = cli.home;
    process.env.USERPROFILE = cli.home;
    const profileWritten = createDeferredCore<string>();
    const releaseProfile = createDeferredCore();
    let options: Options | undefined;
    let projectOwner: ProjectOwner | undefined;
    let setupError: unknown;
    let cleanupAttempts = 0;
    const projectFactorySpy = vi
      .spyOn(projectPreparation, "createWorkerProjectPreparation")
      .mockImplementation((params) => {
        const owner = createProjectOwner(params);
        projectOwner = owner;
        return owner;
      });
    ioHook.afterProfileWrite = async (file) => {
      profileWritten.resolve(file);
      if (scenario.point === "profile") {
        await releaseProfile.promise;
      }
    };
    const setup = scenario.failSetup ? "process.exit(17);" : cli.setup;
    // Only allocation/bootstrap/CLI transport is synthetic. The service creates
    // both authority owners; this adapter uses them unchanged at the actual setup entry.
    const service = providerService(
      {
        supportsProjectPreparation: () => true,
        provision: async (settings, _operation, supplied) => {
          const profile = parseCrabboxProfile(settings);
          options = expectDefined(supplied, "Gateway provision options");
          expect(options.project).toBe(
            expectDefined(projectOwner, "Gateway project owner").project,
          );
          const authority = createCrabboxProvisionAuthority(options);
          authority.assertCurrent();
          try {
            await runProvisionSetup({
              binary: cli.binary,
              provider: profile.provider,
              profile,
              inspect: { id: "lease-1", state: "running", tailscaleEnabled: false },
              deadline: performance.now() + 10_000,
              timeoutMs: 5_000,
              phase: scenario.phase,
              setup,
              forwardedEnv: cli.forwardedEnv,
              ...authority,
              stopLease: async () => {
                cleanupAttempts++;
                await stopCrabboxLease({
                  binary: cli.binary,
                  id: "lease-1",
                  provider: profile.provider,
                  warn: () => {},
                  ...authority,
                });
              },
            });
            return { leaseId: "lease-1", ssh: support.SSH_ENDPOINT };
          } catch (error) {
            setupError = error;
            throw error;
          }
        },
      },
      { projectNamespace: "gateway" },
    );
    const creating = create(service, "final-effect", { projectPath: repo.root });
    try {
      const gate =
        scenario.point === "profile"
          ? profileWritten.promise.then(() => undefined)
          : cli.firstAttempt;
      await beforeSettlement(gate, creating, "setup boundary: " + scenario.name);
      const file = await profileWritten.promise;
      expect(await fs.readFile(file, "utf8")).toContain('PROOF_TOKEN="' + cli.token + '"');
      const actual = expectDefined(options, "captured Gateway provision options");
      expect(actual.signal?.aborted).not.toBe(true);
      expect(actual.project?.signal?.aborted).not.toBe(true);
      if (scenario.revoke === "host") {
        const records = support.testState.store.list();
        expect(records).toHaveLength(1);
        const record = expectDefined(records[0], "provisioning environment record");
        await support.testState.store.requestDestroy({
          environmentId: record.environmentId,
          state: record.state,
        });
        expect(
          expectDefined(
            support.testState.store.get(record.environmentId),
            "current environment record",
          ).destroyRequestedAtMs,
        ).not.toBeNull();
        expect(() => expectDefined(actual.assertCurrent, "Gateway host assertion")()).toThrow(
          "Worker provisioning operation is closed",
        );
      } else if (scenario.revoke === "project") {
        // Revoke the actual lifecycle owner, not a boolean authorizer or a fake assertion.
        expectDefined(projectOwner, "Gateway project owner").close();
        expect(() => expectDefined(actual.assertCurrent, "Gateway host assertion")()).not.toThrow();
        expect(actual.project?.signal?.aborted).toBe(true);
      }
      // The dispatch signal cannot be the reason the old implementation is stopped.
      expect(actual.signal?.aborted).not.toBe(true);
      releaseProfile.resolve();
      cli.releaseRetry();
      const result = await creating.then(
        () => "created",
        () => "failed",
      );
      const events = await cli.events();
      expect(
        events.filter((event) => event === "run"),
        inspectError(setupError),
      ).toHaveLength(scenario.runs);
      expect(events.filter((event) => event.startsWith("stdin:"))).toHaveLength(scenario.runs);
      expect(events.filter((event) => event.includes("inherited=true"))).toEqual([]);
      if (scenario.revoke) {
        expect(result).toBe("failed");
        expect(setupError).toMatchObject({ code: "cleanup_indeterminate", leaseId: "lease-1" });
        expect(cleanupAttempts).toBe(1);
        expect(support.testState.store.list()).toEqual([
          expect.objectContaining({ state: "destroying", leaseId: "lease-1" }),
        ]);
        expect(events.filter((event) => event === "stop")).toEqual([]);
        expect(await cli.effect()).toBe("not-run");
      } else if (scenario.failSetup) {
        expect(result).toBe("failed");
        expect(setupError).toMatchObject({ code: "cleanup_complete", leaseId: "lease-1" });
        expect(cleanupAttempts).toBe(1);
        expect(events.filter((event) => event === "stop")).toHaveLength(1);
      } else {
        expect(result).toBe("created");
        expect(events.filter((event) => event.startsWith("stdin:"))).toEqual(
          Array.from(
            { length: scenario.runs },
            () => "stdin:" + cli.setupDigest + ":inherited=false",
          ),
        );
        expect(await cli.effect()).toBe(cli.token);
        expect(cleanupAttempts).toBe(0);
      }
      await expect(fs.stat(file)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(fs.stat(path.dirname(file))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      ioHook.afterProfileWrite = undefined;
      releaseProfile.resolve();
      cli.releaseRetry();
      await creating.catch(() => undefined);
      await service.stop();
      projectFactorySpy.mockRestore();
      await cli.close();
      for (const [key, value] of Object.entries(originalHome)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    }
  });
});
