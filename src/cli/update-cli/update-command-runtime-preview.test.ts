import fs from "node:fs";
import path from "node:path";
import { beforeEach, expect, it, vi } from "vitest";
import * as runtimePaths from "../../daemon/runtime-paths.js";
import * as daemonService from "../../daemon/service.js";
import { createMockGatewayService } from "../../daemon/service.test-helpers.js";
import * as gatewaySupervision from "../../infra/gateway-supervision.js";
import * as activationPaths from "../../infra/package-update-activation-paths.js";
import * as packageMetadata from "../../infra/update-check-package-target.js";
import * as updateGlobal from "../../infra/update-global.js";
import { defaultRuntime } from "../../runtime.js";
import { quoteCliArg, quotePowerShellArg } from "../quote-cli-arg.js";
import * as shared from "./shared.js";
import * as databaseContext from "./update-command-database-context.js";
import { runtimeFixture } from "./update-command-fixtures.test-support.js";
import { installFreshUpdateFixture, targetMetadata } from "./update-command-fresh.test-support.js";
import * as runtimeRecovery from "./update-command-node-runtime-resolution.js";
import * as packageUpdate from "./update-command-package.js";
import {
  expectedRuntimeRecoverySteps,
  stubNodeRuntime,
} from "./update-command-runtime-recovery.test-support.js";
import { updateCommand } from "./update-command.js";

vi.mock("../../infra/container-environment.js", () => ({ isContainerEnvironment: () => false }));

const { fixture } = installFreshUpdateFixture();
const quote = process.platform === "win32" ? quotePowerShellArg : quoteCliArg;
const lastJson = () => vi.mocked(defaultRuntime.writeJson).mock.lastCall?.[0];
const matchingEntry = (shape: object) => expect.arrayContaining([expect.objectContaining(shape)]);
function expectUnstaged() {
  expect(packageUpdate.stagePackageInstallUpdate).not.toHaveBeenCalled();
  expect(fs.existsSync(fixture.databasePath)).toBe(false);
}
beforeEach(() => {
  vi.stubEnv("OPENCLAW_DISABLE_BUNDLED_PLUGINS", "1");
});
it.each([
  ["24.16.0", true],
  ["26.1.0", false],
] as const)(
  "warns without refusing an update preview under compatible service Node %s",
  async (version, json) => {
    stubNodeRuntime();
    fixture.managedServiceNodeRunner = process.execPath;
    vi.spyOn(runtimePaths, "resolveNodeRuntimeInfo").mockResolvedValue(
      runtimeFixture(version, "3.53.0"),
    );
    vi.mocked(packageMetadata.fetchNpmPackageTargetStatus).mockResolvedValue({
      ...targetMetadata,
      nodeEngine: ">=24.16.0 <25 || >=26.1.0",
    });
    const log = vi.spyOn(defaultRuntime, "log").mockImplementation(() => undefined);

    await updateCommand({ tag: targetMetadata.version, yes: true, dryRun: true, json });

    const output = json ? JSON.stringify(lastJson()) : log.mock.calls.flat().join("\n");
    expect(output).toContain("SECURITY WARNING");
    expect(output).toContain(`Node.js ${version}`);
    expect(output).not.toContain("Would refuse update");
    expectUnstaged();
  },
);

it.each([
  { name: "no restart", restart: false, debugCapture: true },
  { name: "replacement" },
  { name: "compatible", compatible: true },
  { name: "foreign service", owned: false },
  { name: "current replacement", current: true },
  { name: "current sealed service", current: true, refresh: false },
  { name: "current no restart", current: true, restart: false },
  { name: "current stopped service", current: true, running: false },
  { name: "text refusal", restart: false, json: false, debugCapture: true },
])(
  "previews installed package runtime admission without mutation ($name)",
  async ({
    restart = true,
    compatible = false,
    current = false,
    refresh = true,
    json = true,
    owned = true,
    running = true,
    debugCapture = false,
  }) => {
    stubNodeRuntime();
    vi.stubEnv("OPENCLAW_DEBUG_PROXY_ENABLED", debugCapture ? "yes" : "0");
    vi.stubEnv("OPENCLAW_DEBUG_PROXY_URL", undefined);
    vi.stubEnv("OPENCLAW_DEBUG_PROXY_REQUIRE", undefined);
    fixture.managedServiceNodeRunner = "/service/node";
    const captureRuntime = activationPaths.capturePackageActivationRuntime;
    vi.spyOn(activationPaths, "capturePackageActivationRuntime").mockImplementation(
      (kind, executable) =>
        executable === "/service/node" || executable === "/current/node"
          ? { kind, path: executable, identity: `synthetic:${executable}` }
          : captureRuntime(kind, executable),
    );
    const provisionRuntime = vi
      .spyOn(runtimeRecovery, "resolveTargetNodeRuntime")
      .mockRejectedValue(new Error("A retained service runtime must not be provisioned"));
    vi.spyOn(shared, "resolveNodeRunner").mockReturnValue("/current/node");
    vi.spyOn(gatewaySupervision, "assertGatewayServiceMutationAllowed").mockReturnValue();
    vi.spyOn(daemonService, "resolveGatewayService").mockReturnValue(
      createMockGatewayService({
        isLoaded: async () => true,
        readRuntime: async () => ({
          status: running ? "running" : "stopped",
          systemd: { managerUid: 2001 },
        }),
        readCommand: async () =>
          owned
            ? {
                programArguments: [
                  "/service/node",
                  path.join(fixture.root, "dist/index.mjs"),
                  "gateway",
                ],
              }
            : null,
      }),
    );
    vi.spyOn(runtimePaths, "resolveNodeRuntimeInfo").mockImplementation(async (node) =>
      runtimeFixture(compatible || node === "/current/node" ? "26.12.1" : "24.22.1", "3.53.0"),
    );
    vi.mocked(packageMetadata.fetchNpmPackageTargetStatus).mockResolvedValue({
      ...targetMetadata,
      nodeEngine: ">=26.12.1",
    });
    if (current) {
      fs.writeFileSync(
        path.join(fixture.root, "package.json"),
        JSON.stringify({ name: "openclaw", version: targetMetadata.version }),
      );
      const inspect = vi
        .mocked(databaseContext.inspectUpdateDatabaseContexts)
        .getMockImplementation()!;
      vi.mocked(databaseContext.inspectUpdateDatabaseContexts).mockImplementation(
        async (params) => ({
          ...(await inspect(params)),
          service: {
            stopped: false,
            inspected: true,
            runtimeInspected: true,
            running,
            serviceNodeRunner: fixture.managedServiceNodeRunner,
            serviceUpdateVerdict: {
              kind: "owned",
              root: fixture.root,
              fingerprint: "fixture",
              refreshDefinition: refresh,
            },
          },
        }),
      );
    }
    const log = vi.spyOn(defaultRuntime, "log").mockImplementation(() => undefined);
    const manifest = fs.readFileSync(path.join(fixture.root, "package.json"));
    const opts = { tag: targetMetadata.version, yes: true, json, restart };

    await updateCommand({ ...opts, dryRun: true });

    const captureNotices = vi
      .mocked(defaultRuntime.error)
      .mock.calls.filter(
        ([message]) =>
          message === "Warning: Debug HTTP capture is disabled during update dry runs.",
      );
    expect(captureNotices).toHaveLength(debugCapture ? 1 : 0);
    const preview = lastJson();
    const notes = json ? JSON.stringify(preview) : log.mock.calls.flat().join("\n");
    const replacement = !compatible && restart && owned && current && running && refresh;
    if (!compatible && !replacement) {
      const recoverySteps = expectedRuntimeRecoverySteps(
        "26.12.1",
        fixture.root,
        "2026.9.2",
        undefined,
        current && (!running || !refresh) ? "/service/node" : undefined,
      );
      const message = [
        "Recovery:",
        ...recoverySteps.map(
          (step, index) =>
            `${index + 1}. ${"command" in step ? `Run \`${step.command}\`.` : step.instruction}`,
        ),
      ].join("\n");
      if (json) {
        expect(preview).toMatchObject({
          notes: [expect.stringContaining(message)],
          failures: [
            {
              reason: current ? "node-runtime-preflight" : "preflight-node-runtime-incompatible",
              message: expect.stringContaining(message),
              recoverySteps,
              failureFacts: matchingEntry({
                check: "node-runtime",
                code: "node-runtime-preflight",
                affectedKey: "engines.node",
                message:
                  "Required: openclaw@2026.9.2 Node >=26.12.1; detected: Node 24.22.1 at [redacted-path]",
              }),
            },
          ],
        });
      } else {
        expect(log).toHaveBeenCalledWith(expect.stringContaining(message));
      }
    } else if (replacement) {
      expect(notes).toContain("/service/node");
      expect(notes).toContain("/current/node");
      expect(notes).toContain("Would replace");
    } else {
      expect(notes).not.toMatch(/Would (?:refuse|replace)/);
    }
    if (json && (compatible || replacement)) {
      expect(preview).not.toHaveProperty("failures");
    }
    expectUnstaged();
    expect(fs.readFileSync(path.join(fixture.root, "package.json"))).toEqual(manifest);

    if (!current) {
      await expect(
        updateCommand({ ...opts, json: true, admission: "installed" }),
      ).rejects.toBeInstanceOf(Error);
      if (compatible) {
        expect(packageUpdate.stagePackageInstallUpdate).toHaveBeenCalledWith(
          expect.objectContaining({ nodeRunner: replacement ? "/current/node" : "/service/node" }),
        );
      } else {
        expect(lastJson()).toMatchObject({
          reason: "preflight-node-runtime-incompatible",
          steps: matchingEntry({
            stderrTail: expect.stringContaining(
              `node ${quote(path.join(fixture.root, "openclaw.mjs"))} update --tag 2026.9.2`,
            ),
            failureFacts: matchingEntry({
              code: "node-runtime-preflight",
              message: expect.stringContaining("Required: openclaw@2026.9.2 Node >=26.12.1"),
            }),
          }),
        });
        expect(packageUpdate.stagePackageInstallUpdate).not.toHaveBeenCalled();
      }
      expect(fs.existsSync(fixture.databasePath)).toBe(false);
    }
    expect(provisionRuntime).not.toHaveBeenCalled();
  },
);

it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
  "previews the global directory permission reason without staging or creating state",
  async () => {
    const globalRoot = path.join(path.dirname(fixture.root), "prefix", "lib", "node_modules");
    fs.mkdirSync(globalRoot, { recursive: true });
    vi.mocked(updateGlobal.resolveGlobalInstallTarget).mockResolvedValue({
      manager: "npm",
      command: "npm",
      globalRoot,
      packageRoot: fixture.root,
      npmOwner: { version: "12.0.0", lifecyclePolicy: "allow-scripts" },
    });
    fs.chmodSync(globalRoot, 0o555);
    try {
      await updateCommand({ dryRun: true, json: true, yes: true });
      expect(lastJson()).toMatchObject({
        dryRun: true,
        failures: [
          {
            reason: "global-install-permission-denied",
            message: expect.stringContaining(globalRoot),
            failureFacts: [{ code: "global-install-permission-denied" }],
          },
        ],
      });
      expectUnstaged();
      expect(fs.readdirSync(globalRoot)).toEqual([]);
    } finally {
      fs.chmodSync(globalRoot, 0o755);
    }
  },
);
