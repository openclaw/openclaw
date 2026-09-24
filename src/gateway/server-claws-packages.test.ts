import { randomUUID } from "node:crypto";
import { ok } from "@openclaw/normalization-core/result";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { z } from "zod";
import { createDeferred } from "../../test/helpers/promise.js";
import { buildClawRemovalFixture } from "../claws/lifecycle-remove.test-support.js";
import { resolveClawMonitorCleanupBinding } from "../claws/monitor-cleanup-binding.js";
import {
  type clawPackageRemovalRequestSchema,
  clawPackageRemovalResultSchema,
} from "../claws/package-remove-contract.js";
import {
  digestClawPackageRemovalPlan,
  digestClawRemovalInstall,
} from "../claws/package-remove-plan.js";
import { planClawPackageRemovals } from "../claws/package-remove.js";
import {
  persistClawInstallRecord,
  persistClawPackageRef,
  readClawInstallRecord,
  readClawPackageRefs,
  updateClawInstallRecordStatus,
} from "../claws/provenance.js";
import {
  PluginRuntimeApplicationError,
  type PluginLifecycleRuntimeApply,
} from "../plugins/lifecycle.js";
import type { uninstallPluginWithPolicy } from "../plugins/management-uninstall.js";
import { withPluginLifecycleLease } from "../plugins/plugin-lifecycle-lease.js";
import {
  beginAgentDeletionJournal,
  readAgentDeletionJournal,
} from "../state/agent-deletion-journal.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { authorizeOperatorScopesForMethod } from "./method-scopes.js";
import { clawsPackageHandlers } from "./server-methods/claws-packages.js";
import type { RespondFn } from "./server-methods/types.js";

type ClawPackageRemovalRequest = z.infer<typeof clawPackageRemovalRequestSchema>;

const mocks = vi.hoisted(() => ({ status: vi.fn(), resolve: vi.fn(), uninstall: vi.fn() }));
vi.mock("../claws/lifecycle-status.js", () => ({
  readClawStatus: (...args: unknown[]) => mocks.status(...args),
}));
vi.mock("../plugins/plugin-install-preflight.js", async (original) => ({
  ...(await original<typeof import("../plugins/plugin-install-preflight.js")>()),
  resolveInstalledClawHubPlugin: (...args: unknown[]) => mocks.resolve(...args),
}));
vi.mock("../plugins/management-uninstall.js", () => ({
  uninstallPluginWithPolicy: (...args: unknown[]) => mocks.uninstall(...args),
}));

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) {
    await cleanup();
  }
});

async function fixture(uninstallWarnings: string[] = []) {
  vi.clearAllMocks();
  const state = await createOpenClawTestState({ prefix: "claw-package-owner-" });
  cleanups.push(() => state.cleanup());
  const { plan } = await buildClawRemovalFixture(state.root);
  const install = persistClawInstallRecord(plan);
  const pkg = {
    kind: "plugin" as const,
    source: "clawhub" as const,
    ref: "audit",
    version: "1.0.0",
    integrity: "sha256:audit",
  };
  persistClawPackageRef(plan, pkg);
  const claim = () =>
    beginAgentDeletionJournal({
      operationId: randomUUID(),
      agentId: "worker",
      workspaceDir: plan.agent.workspace,
      agentDir: state.agentDir("worker"),
      sessionsDir: state.sessionsDir("worker"),
      deleteFiles: false,
    });
  const journal = claim();
  const application = { operationId: "runtime-removal", generation: 2, pluginIds: ["audit"] };
  mocks.status.mockImplementation(async () => ({
    records: [
      {
        install: readClawInstallRecord("worker"),
        packages: readClawPackageRefs({ agentId: "worker" }),
      },
    ],
  }));
  mocks.resolve.mockResolvedValue({
    status: "found",
    pluginId: "audit",
    installedVersion: "1.0.0",
    record: {
      source: "clawhub",
      integrity: pkg.integrity,
      installedAt: "1970-01-01T00:00:00.001Z",
    },
  });
  mocks.uninstall.mockImplementation(
    async (input: Parameters<typeof uninstallPluginWithPolicy>[0]) => {
      input.beforePersistentApply?.();
      const change = {
        config: {},
        pluginIds: ["audit"],
        reason: "uninstall" as const,
        assertInvokerOwned: input.beforePersistentApply,
      };
      await input.applyRuntime?.(change);
      input.beforePersistentApply?.();
      for (const warning of uninstallWarnings) {
        input.onWarning?.(warning);
      }
      const applied = await input.applyRuntime?.(change);
      input.beforePersistentApply?.();
      return ok({
        pluginId: "audit",
        requestedPluginId: "audit",
        pluginIds: ["audit"],
        removed: ["directory"],
        warnings: [...uninstallWarnings, ...(applied?.warnings ?? [])],
        application: applied,
      });
    },
  );
  const cleanup = { mode: "remove-selected" as const, selected: ["plugin:audit@1.0.0"] };
  const decisions = await planClawPackageRemovals(
    install,
    readClawPackageRefs({ agentId: "worker" }),
    { referencedCleanup: cleanup },
  );
  const storePath = state.statePath("cron", "jobs.json");
  const input: ClawPackageRemovalRequest = {
    agentId: "worker",
    operationId: journal.operationId,
    binding: resolveClawMonitorCleanupBinding(storePath),
    expectedInstallDigest: digestClawRemovalInstall(install),
    expectedPackagePlanDigest: digestClawPackageRemovalPlan(decisions, cleanup),
    cleanup,
  };
  const controller = new AbortController();
  const applyRuntime = vi.fn<PluginLifecycleRuntimeApply>(async (change) => {
    change.assertInvokerOwned?.();
    return application;
  });
  const invoke = async (overrides: Partial<ClawPackageRemovalRequest> = {}) => {
    let response: unknown;
    let failure: Parameters<RespondFn>[2];
    const respond: RespondFn = (success, payload, error) => {
      if (success) {
        response = payload;
      } else {
        failure = error;
      }
    };
    await clawsPackageHandlers["claws.packages.remove"]({
      params: { ...input, ...overrides },
      context: {
        cronStorePath: storePath,
        getRuntimeConfig: () => ({}),
        applyPluginLifecycleChange: applyRuntime,
      },
      respond,
      signal: controller.signal,
    });
    if (failure) {
      throw new Error(failure.message, { cause: failure });
    }
    return clawPackageRemovalResultSchema.parse(response);
  };
  return {
    state,
    plan,
    pkg,
    decisions,
    input,
    application,
    invoke,
    claim,
    applyRuntime,
    controller,
  };
}

describe("Gateway Claw package cleanup owner", () => {
  it("requires administrative scope", () => {
    expect(
      authorizeOperatorScopesForMethod("claws.packages.remove", ["operator.read"]),
    ).toMatchObject({ allowed: false });
    expect(
      authorizeOperatorScopesForMethod("claws.packages.remove", ["operator.admin"]),
    ).toMatchObject({ allowed: true });
  });

  it.each([
    { runtimeWarnings: [], uninstallWarnings: [] },
    { runtimeWarnings: ["Runtime cleanup is still finishing."], uninstallWarnings: [] },
    { runtimeWarnings: [], uninstallWarnings: ["Package dependency pruning failed."] },
    {
      runtimeWarnings: ["Runtime cleanup is still finishing."],
      uninstallWarnings: [
        "Package dependency pruning failed.",
        "Runtime cleanup is still finishing.",
      ],
    },
  ])("returns actual removal application and all cleanup warnings %j", async (warnings) => {
    const f = await fixture(warnings.uninstallWarnings);
    f.applyRuntime.mockResolvedValue({ ...f.application, warnings: warnings.runtimeWarnings });
    const result = await f.invoke();
    const expectedWarnings = [
      ...new Set([...warnings.uninstallWarnings, ...warnings.runtimeWarnings]),
    ];
    expect(result).toEqual({
      packages: [{ kind: "plugin", ref: "audit", version: "1.0.0", action: "uninstalled" }],
      application: f.application,
      ...(expectedWarnings.length ? { warnings: expectedWarnings } : {}),
    });
    expect(readClawPackageRefs({ agentId: "worker" })[0]?.status).toBe("complete");
    expect(mocks.uninstall).toHaveBeenCalledOnce();
  });

  it.each([true, false])(
    "reports current runtime facts after replacement failure (committed=%s)",
    async (committed) => {
      const policyWarnings = ["Package dependency pruning failed."];
      const runtimeWarnings = ["Earlier runtime cleanup is still finishing."];
      const f = await fixture(policyWarnings);
      const failure = new PluginRuntimeApplicationError(
        "Plugin operation failed during activate.",
        {
          ...f.application,
          operationId: "runtime-final",
          generation: committed ? 3 : 2,
          phase: "activate",
          committed,
        },
      );
      f.applyRuntime
        .mockResolvedValueOnce({ ...f.application, warnings: runtimeWarnings })
        .mockRejectedValueOnce(failure);
      await expect(f.invoke()).resolves.toEqual({
        packages: [
          {
            kind: "plugin",
            ref: "audit",
            version: "1.0.0",
            action: "error",
            reason: failure.message,
          },
        ],
        application: committed
          ? { ...f.application, operationId: "runtime-final", generation: 3 }
          : f.application,
        warnings: [...policyWarnings, ...runtimeWarnings],
      });
      expect(f.applyRuntime).toHaveBeenCalledTimes(2);
      expect(readClawPackageRefs({ agentId: "worker" })[0]?.status).toBe("failed");
    },
  );

  it.each(["journal", "install", "selection", "unknown selection", "binding"])(
    "rejects changed %s before mutation",
    async (change) => {
      const f = await fixture();
      if (change === "journal") {
        f.claim();
      }
      if (change === "install") {
        updateClawInstallRecordStatus("worker", "partial");
      }
      const overrides: Partial<ClawPackageRemovalRequest> = {};
      if (change === "selection") {
        overrides.cleanup = { ...f.input.cleanup, allowConflicts: true };
      }
      if (change === "unknown selection") {
        overrides.cleanup = {
          ...f.input.cleanup,
          selected: ["plugin:audit@1.0.0", "plugin:unowned@1.0.0"],
        };
        // A matching comparison digest cannot waive the canonical planner's blocker.
        overrides.expectedPackagePlanDigest = digestClawPackageRemovalPlan(
          f.decisions,
          overrides.cleanup,
        );
      }
      if (change === "binding") {
        overrides.binding = { ...f.input.binding, statePath: "/different-state" };
      }
      await expect(f.invoke(overrides)).rejects.toThrow();
      expect(mocks.uninstall).not.toHaveBeenCalled();
      expect(readClawPackageRefs({ agentId: "worker" })[0]?.status).toBe("complete");
    },
  );

  it("rejects lifecycle contention before removal and replans dependencies on retry", async () => {
    const f = await fixture();
    const journal = readAgentDeletionJournal("worker");
    const refs = readClawPackageRefs({ agentId: "worker" });
    const entered = createDeferred();
    const release = createDeferred();
    const holder = withPluginLifecycleLease({}, async () => {
      entered.resolve();
      await release.promise;
      persistClawPackageRef({ ...f.plan, agent: { ...f.plan.agent, finalId: "other" } }, f.pkg);
    });
    await entered.promise;
    let reply: unknown;
    const pending = f
      .invoke()
      .catch((error: unknown) => error)
      .then((result) => {
        reply = result;
      });
    try {
      await vi.waitFor(
        () =>
          expect(reply).toMatchObject({
            cause: {
              code: "UNAVAILABLE",
              retryable: true,
              message: expect.stringContaining("retry"),
            },
          }),
        { timeout: 1_000 },
      );
      expect(mocks.uninstall).not.toHaveBeenCalled();
      expect(f.applyRuntime).not.toHaveBeenCalled();
      expect(readAgentDeletionJournal("worker")).toEqual(journal);
      expect(readClawPackageRefs({ agentId: "worker" })).toEqual(refs);
      release.resolve();
      await holder;
      await expect(f.invoke()).rejects.toThrow("ownership changed");
      expect(mocks.uninstall).not.toHaveBeenCalled();
      expect(f.applyRuntime).not.toHaveBeenCalled();
    } finally {
      f.controller.abort();
      release.resolve();
      await Promise.allSettled([holder, pending]);
    }
  });

  it.each(["journal", "request"])(
    "does not mutate or compensate after %s ownership is lost during drain",
    async (change) => {
      const f = await fixture();
      const entered = createDeferred();
      const release = createDeferred();
      f.applyRuntime.mockImplementation(async (input) => {
        entered.resolve();
        await release.promise;
        input.assertInvokerOwned?.();
        return f.application;
      });
      const pending = f.invoke();
      await entered.promise;
      if (change === "journal") {
        f.claim();
      } else {
        f.controller.abort(new Error("request ended"));
      }
      const journal = readAgentDeletionJournal("worker");
      const refs = readClawPackageRefs({ agentId: "worker" });
      release.resolve();
      await expect(pending).rejects.toThrow();
      expect(readAgentDeletionJournal("worker")).toEqual(journal);
      expect(readClawPackageRefs({ agentId: "worker" })).toEqual(refs);
    },
  );
});
