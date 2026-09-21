import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as service from "../../daemon/service.js";
import {
  createMockGatewayService,
  mockSystemAccountHome,
} from "../../daemon/service.test-helpers.js";
import { writePackageRoot } from "../../infra/package-update-steps.test-support.js";
import { CONTROL_PLANE_UPDATE_SENTINEL_META_ENV } from "../../infra/update-control-plane-sentinel.js";
import { pkgQueryResult } from "../../infra/update-freebsd-pkg-ownership.test-support.js";
import * as updateRunner from "../../infra/update-runner-git.js";
import * as exec from "../../process/exec.js";
import { withTestDir } from "../../test-helpers/temp-dir.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { withMockedPlatform } from "../../test-utils/vitest-spies.js";
import * as shared from "./shared.js";
import { updateGitInstall } from "./update-command-git.js";
import { prepareUpdateCommand, resolveUpdateCommandAdmissionEnv } from "./update-command-run.js";
import { resolveManagedServicePackageUpdatePlan } from "./update-command-service-plan.js";
import { resolveUpdateCommandTarget } from "./update-command-target.js";

afterEach(() => vi.restoreAllMocks());

async function withPackageRoots(
  run: (base: string, requested: string, managed: string) => Promise<void>,
) {
  await withTestDir({ prefix: "openclaw-update-pkg-" }, async (base) => {
    const requested = path.join(base, "requested", "lib", "node_modules", "openclaw");
    const managed = path.join(base, "managed", "lib", "node_modules", "openclaw");
    await writePackageRoot(requested, "1.0.0");
    await writePackageRoot(managed, "1.0.0");
    await withEnvAsync(
      {
        HOME: base,
        OPENCLAW_HOME: undefined,
        OPENCLAW_PROFILE: undefined,
        OPENCLAW_STATE_DIR: undefined,
        OPENCLAW_CONFIG_PATH: undefined,
        OPENCLAW_SUPERVISOR_MODE: undefined,
        OPENCLAW_UPDATE_POST_CORE: undefined,
        OPENCLAW_UPDATE_RUN_ID: undefined,
        [CONTROL_PLANE_UPDATE_SENTINEL_META_ENV]: undefined,
      },
      async () => {
        mockSystemAccountHome();
        await withMockedPlatform("freebsd", () => run(base, requested, managed));
      },
    );
  });
}

describe("FreeBSD pkg update admission", () => {
  it.each(["owned", "unknown", "unowned"])(
    "admits the requested root before package-manager probes (%s)",
    async (ownership) => {
      await withPackageRoots(async (_base, root) => {
        const command = vi.spyOn(exec, "runCommandWithTimeout").mockResolvedValue({
          stdout: `${path.dirname(root)}\n`,
          stderr: "",
          code: 0,
          signal: null,
          killed: false,
          termination: "exit",
        });
        vi.spyOn(exec, "runCommandBuffered").mockResolvedValue(
          pkgQueryResult(
            ownership === "owned" ? `${root}/package.json\n` : "",
            ownership === "unknown" ? { code: 1 } : {},
          ),
        );
        const admission = shared.resolveGlobalManager({
          root,
          installKind: "package",
          timeoutMs: 1000,
        });
        if (ownership === "unowned") {
          await expect(admission).resolves.toBe("npm");
          expect(command).toHaveBeenCalled();
        } else {
          await expect(admission).rejects.toMatchObject({
            reason: ownership === "owned" ? "pkg-owned-install" : "pkg-ownership-unavailable",
          });
          expect(command).not.toHaveBeenCalled();
        }
      });
    },
  );

  it("reuses completed admission after a long confirmation without timing out path inspection", async () => {
    await withPackageRoots(async (_base, root) => {
      vi.spyOn(shared, "resolveUpdateRoot").mockResolvedValue(root);
      vi.spyOn(service, "resolveGatewayService").mockReturnValue(createMockGatewayService());
      const query = vi.spyOn(exec, "runCommandBuffered").mockResolvedValue(pkgQueryResult());
      const prepared = await prepareUpdateCommand({ dryRun: true });
      vi.spyOn(Date, "now").mockReturnValue(Date.now() + 60_000);
      await expect(
        resolveUpdateCommandAdmissionEnv({
          root,
          opts: { dryRun: true },
          pkgOwnership: prepared.pkgOwnership,
        }),
      ).resolves.toBeDefined();
      expect(query).toHaveBeenCalledTimes(1);
    });
  });

  it("rechecks the selected Git root after its mutation preparation finishes", async () => {
    await withPackageRoots(async (_base, root) => {
      let claimed = false;
      const query = vi
        .spyOn(exec, "runCommandBuffered")
        .mockImplementation(async () => pkgQueryResult(claimed ? `${root}/package.json\n` : ""));
      const publish = vi.fn();
      vi.spyOn(updateRunner, "updateGitCheckout").mockImplementation(async ({ opts }) => {
        await opts.beforeGitMutation?.({});
        publish();
        return { status: "ok", mode: "git", root, steps: [], durationMs: 0 };
      });
      await expect(
        updateGitInstall({
          root,
          switchToGit: false,
          installKind: "git",
          timeoutMs: 1000,
          startedAt: Date.now(),
          progress: {},
          channel: "dev",
          tag: "dev",
          inspectGitTarget: async () => {},
          validateCandidate: async () => {},
          beforeGitMutation: async () => {
            claimed = true;
          },
          getManagedServiceEnv: () => undefined,
          getSnapshotSource: async () => ({ config: {}, env: process.env }),
          allowGatewayServiceRepair: false,
          allowGatewayActivation: false,
        }),
      ).rejects.toMatchObject({ reason: "pkg-owned-install" });
      expect(query).toHaveBeenCalledTimes(2);
      expect(publish).not.toHaveBeenCalled();
    });
  });

  it("refuses a selected pkg-owned Git destination before checkout or manager effects", async () => {
    await withPackageRoots(async (_base, requested, selected) => {
      vi.spyOn(shared, "resolveGitInstallDir").mockReturnValue(selected);
      const manager = vi
        .spyOn(shared, "resolveGlobalManager")
        .mockRejectedValue(new Error("unexpected manager admission"));
      const checkout = vi
        .spyOn(shared, "ensureGitCheckout")
        .mockRejectedValue(new Error("unexpected checkout mutation"));
      const getSnapshotSource = vi.fn(async () => ({ config: {}, env: process.env }));
      vi.spyOn(exec, "runCommandBuffered").mockResolvedValue(
        pkgQueryResult(`${selected}/package.json\n`),
      );
      await expect(
        updateGitInstall({
          root: requested,
          switchToGit: true,
          installKind: "package",
          timeoutMs: 1000,
          startedAt: Date.now(),
          progress: {},
          channel: "dev",
          tag: "dev",
          inspectGitTarget: async () => {},
          validateCandidate: async () => {},
          getManagedServiceEnv: () => undefined,
          getSnapshotSource,
          allowGatewayServiceRepair: false,
          allowGatewayActivation: false,
        }),
      ).rejects.toMatchObject({ reason: "pkg-owned-install" });
      expect(manager).not.toHaveBeenCalled();
      expect(checkout).not.toHaveBeenCalled();
      expect(getSnapshotSource).not.toHaveBeenCalled();
    });
  });

  it.each([
    { name: "ordinary update", opts: {} },
    { name: "no restart", opts: { restart: false } },
    { name: "dry run", opts: { dryRun: true } },
    { name: "package-to-Git switch", opts: { channel: "dev" } },
  ])(
    "refuses the invoking pkg root before service planning or state writes: $name",
    async ({ opts }) => {
      await withPackageRoots(async (base, root) => {
        vi.spyOn(shared, "resolveUpdateRoot").mockResolvedValue(root);
        const readCommand = vi.fn();
        vi.spyOn(service, "resolveGatewayService").mockReturnValue(
          createMockGatewayService({ readCommand }),
        );
        vi.spyOn(exec, "runCommandBuffered").mockResolvedValue(
          pkgQueryResult(`${root}/package.json\n`),
        );
        await expect(prepareUpdateCommand(opts)).rejects.toMatchObject({
          reason: "pkg-owned-install",
        });
        expect(readCommand).not.toHaveBeenCalled();
        await expect(fs.stat(path.join(base, ".openclaw"))).rejects.toMatchObject({
          code: "ENOENT",
        });
      });
    },
  );

  it.each(["state", "profile"])(
    "does not let a non-default %s bypass pkg ownership",
    async (selector) => {
      await withPackageRoots(async (base, root) => {
        vi.spyOn(shared, "resolveUpdateRoot").mockResolvedValue(root);
        vi.spyOn(exec, "runCommandBuffered").mockResolvedValue(
          pkgQueryResult(`${root}/package.json\n`),
        );
        await withEnvAsync(
          selector === "state"
            ? { OPENCLAW_STATE_DIR: path.join(base, "custom-state") }
            : { OPENCLAW_PROFILE: "alternate" },
          async () => {
            await expect(prepareUpdateCommand({ restart: false })).rejects.toMatchObject({
              reason: "pkg-owned-install",
            });
          },
        );
      });
    },
  );

  it.each(["requested", "managed"])(
    "refuses the %s pkg root before applying a service root/runtime redirect",
    async (owner) => {
      await withPackageRoots(async (_base, requested, managed) => {
        const readCommand = vi.fn(async () => ({
          programArguments: [
            "/fixture/bin/node",
            path.join(managed, "dist", "index.js"),
            "gateway",
            "run",
          ],
        }));
        vi.spyOn(service, "resolveGatewayService").mockReturnValue(
          createMockGatewayService({ readCommand }),
        );
        const owned = owner === "requested" ? requested : managed;
        vi.spyOn(exec, "runCommandBuffered").mockResolvedValue(
          pkgQueryResult(`${owned}/package.json\n`),
        );
        await expect(
          resolveManagedServicePackageUpdatePlan({ root: requested }),
        ).rejects.toMatchObject({ reason: "pkg-owned-install" });
        expect(readCommand).toHaveBeenCalledTimes(owner === "requested" ? 0 : 1);
      });
    },
  );

  it("checks pkg ownership before reading admission environment from a service", async () => {
    await withPackageRoots(async (_base, root) => {
      const readCommand = vi.fn();
      const isAbsent = vi.fn();
      vi.spyOn(service, "resolveGatewayService").mockReturnValue(
        createMockGatewayService({ readCommand, isAbsent }),
      );
      vi.spyOn(exec, "runCommandBuffered").mockResolvedValue(
        pkgQueryResult(`${root}/package.json\n`),
      );
      await expect(
        resolveUpdateCommandAdmissionEnv({ root, opts: { restart: false } }),
      ).rejects.toMatchObject({ reason: "pkg-owned-install" });
      expect(readCommand).not.toHaveBeenCalled();
      expect(isAbsent).not.toHaveBeenCalled();
    });
  });

  it("checks a precomputed service redirect before admitting its target", async () => {
    await withPackageRoots(async (_base, root, managed) => {
      vi.spyOn(shared, "resolveUpdateRoot").mockResolvedValue(root);
      vi.spyOn(service, "resolveGatewayService").mockReturnValue(createMockGatewayService());
      vi.spyOn(exec, "runCommandBuffered").mockResolvedValue(
        pkgQueryResult(`${managed}/package.json\n`),
      );
      const prepared = await prepareUpdateCommand({ dryRun: true });
      prepared.servicePlan = {
        rootRedirect: { root: managed, previousRoot: root },
        nodeRunner: "/fixture/bin/node",
      };
      const enter = vi.fn(async () => {
        throw new Error("Package ownership must precede executor admission");
      });
      await expect(
        resolveUpdateCommandTarget(
          { dryRun: true },
          { triageTarget: { env: process.env } },
          undefined,
          prepared,
          { enter },
          1000,
        ),
      ).rejects.toMatchObject({ reason: "pkg-owned-install" });
      expect(enter).not.toHaveBeenCalled();
    });
  });
});
