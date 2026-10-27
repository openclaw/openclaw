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
import { createSystemPackageOwnershipInspection } from "../../infra/update-system-package-ownership.js";
import * as exec from "../../process/exec.js";
import { withTestDir } from "../../test-helpers/temp-dir.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { createCommandResult } from "../../test-utils/npm-spec-install-test-helpers.js";
import { withMockedPlatform } from "../../test-utils/vitest-spies.js";
import * as shared from "./shared.js";
import { updateGitInstall } from "./update-command-git.js";
import { prepareUpdateCommand, resolveUpdateCommandAdmissionEnv } from "./update-command-run.js";
import { resolveManagedServicePackageUpdatePlan } from "./update-command-service-plan.js";
import { resolveUpdateCommandTarget } from "./update-command-target.js";

afterEach(() => vi.restoreAllMocks());

const refuseMutation = async () => {
  throw new Error("Package ownership must be checked before mutation");
};
const mockOwnership = (root = "") =>
  vi
    .spyOn(exec, "runCommandBuffered")
    .mockResolvedValue(pkgQueryResult(root && `${root}/package.json\n`));
function mockInvokingRoot(root: string) {
  vi.spyOn(shared, "resolveUpdateRoot").mockResolvedValue(root);
  vi.spyOn(service, "resolveGatewayService").mockReturnValue(createMockGatewayService());
}

function gitUpdateParams(root: string): Parameters<typeof updateGitInstall>[0] {
  return {
    root,
    switchToGit: false,
    installKind: "git",
    timeoutMs: 1000,
    startedAt: Date.now(),
    progress: {},
    channel: "dev",
    inspectGitTarget: refuseMutation,
    validateCandidate: refuseMutation,
    beforeGitMutation: refuseMutation,
    getManagedServiceEnv: () => undefined,
    getSnapshotSource: async () => ({ config: {}, env: process.env }),
  };
}

async function withPackageRoots(
  run: (base: string, requested: string, managed: string) => Promise<void>,
  platform: NodeJS.Platform = "freebsd",
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
        await withMockedPlatform(platform, () => run(base, requested, managed));
      },
    );
  });
}

describe("FreeBSD pkg update admission", () => {
  it.each(["owned", "unowned", "missing"] as const)(
    "admits pkg roots before npm discovery (%s)",
    async (ownership) => {
      await withPackageRoots(async (_base, root) => {
        const command = vi
          .spyOn(exec, "runCommandWithTimeout")
          .mockResolvedValue(createCommandResult({ stdout: `${path.dirname(root)}\n` }));
        vi.spyOn(exec, "runCommandBuffered").mockResolvedValue(
          pkgQueryResult(
            ownership === "owned" ? `${root}/package.json\n` : "",
            ownership === "missing"
              ? {
                  code: null,
                  termination: "error",
                  error: Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }),
                }
              : {},
          ),
        );
        const onWarning = vi.fn();
        const admission = shared.resolveGlobalManager({
          root,
          installKind: "package",
          timeoutMs: 1000,
          pkgOwnership: createSystemPackageOwnershipInspection(1000, { onWarning }),
        });
        if (ownership !== "owned") {
          await expect(admission).resolves.toBe("npm");
          if (ownership === "missing") {
            expect(onWarning).toHaveBeenCalledExactlyOnceWith(
              expect.stringContaining("pkg executable was not found"),
            );
            expect(onWarning.mock.calls[0]?.[0]).toContain(
              "Continuing without verified system-package ownership.",
            );
            expect(onWarning.mock.calls[0]?.[0]).not.toContain("Restore access");
          } else {
            expect(onWarning).not.toHaveBeenCalled();
          }
        } else {
          await expect(admission).rejects.toMatchObject({ reason: "pkg-owned-install" });
          expect(command).not.toHaveBeenCalled();
        }
      });
    },
  );

  it("reuses completed admission after a long confirmation without timing out path inspection", async () => {
    await withPackageRoots(async (_base, root) => {
      mockInvokingRoot(root);
      const query = mockOwnership();
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
      vi.spyOn(exec, "runCommandBuffered").mockImplementation(async () =>
        pkgQueryResult(claimed ? `${root}/package.json\n` : ""),
      );
      const publish = vi.fn();
      vi.spyOn(updateRunner, "updateGitCheckout").mockImplementation(async ({ opts }) => {
        await opts.beforeGitMutation({});
        publish();
        return { status: "ok", mode: "git", root, steps: [], durationMs: 0 };
      });
      await expect(
        updateGitInstall({
          ...gitUpdateParams(root),
          beforeGitMutation: async () => {
            claimed = true;
          },
        }),
      ).rejects.toMatchObject({ reason: "pkg-owned-install" });
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
      mockOwnership(selected);
      await expect(
        updateGitInstall({
          ...gitUpdateParams(requested),
          switchToGit: true,
          installKind: "package",
          getSnapshotSource,
        }),
      ).rejects.toMatchObject({ reason: "pkg-owned-install" });
      expect(manager).not.toHaveBeenCalled();
      expect(checkout).not.toHaveBeenCalled();
      expect(getSnapshotSource).not.toHaveBeenCalled();
    });
  });

  it.each([
    { name: "ordinary update", opts: {} },
    { name: "dry run", opts: { dryRun: true } },
  ])(
    "refuses the invoking pkg root before service planning or state writes: $name",
    async ({ opts }) => {
      await withPackageRoots(async (base, root) => {
        vi.spyOn(shared, "resolveUpdateRoot").mockResolvedValue(root);
        const readCommand = vi.fn();
        vi.spyOn(service, "resolveGatewayService").mockReturnValue(
          createMockGatewayService({ readCommand }),
        );
        mockOwnership(root);
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
        mockOwnership(owned);
        await expect(
          resolveManagedServicePackageUpdatePlan({ root: requested }),
        ).rejects.toMatchObject({ reason: "pkg-owned-install" });
        expect(readCommand).toHaveBeenCalledTimes(owner === "requested" ? 0 : 1);
      });
    },
  );

  it("checks a precomputed service redirect before admitting its target", async () => {
    await withPackageRoots(async (_base, root, managed) => {
      mockInvokingRoot(root);
      mockOwnership(managed);
      const prepared = await prepareUpdateCommand({ dryRun: true });
      prepared.servicePlan = {
        rootRedirect: { root: managed, previousRoot: root },
        nodeRunner: "/fixture/bin/node",
      };
      const enter = vi.fn(refuseMutation);
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
