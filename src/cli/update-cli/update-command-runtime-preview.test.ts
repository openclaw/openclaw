import fs from "node:fs";
import path from "node:path";
import { expect, it, vi } from "vitest";
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
import { installFreshUpdateFixture, targetMetadata } from "./update-command-fresh.test-support.js";
import * as runtimeRecovery from "./update-command-node-runtime-resolution.js";
import * as packageUpdate from "./update-command-package.js";
import { stubNodeRuntime } from "./update-command-runtime-recovery.test-support.js";
import { updateCommand } from "./update-command.js";

vi.mock("../../infra/container-environment.js", () => ({ isContainerEnvironment: () => false }));

const { fixture } = installFreshUpdateFixture();
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
    const service = createMockGatewayService({
      isLoaded: async () => true,
      readRuntime: async () => ({
        status: running ? "running" : "stopped",
        systemd: { managerUid: 2001 },
      }),
    });
    vi.spyOn(service, "readCommand").mockResolvedValue(
      owned
        ? {
            programArguments: [
              "/service/node",
              path.join(fixture.root, "dist/index.mjs"),
              "gateway",
            ],
          }
        : null,
    );
    vi.spyOn(daemonService, "resolveGatewayService").mockReturnValue(service);
    vi.spyOn(runtimePaths, "resolveNodeRuntimeInfo").mockImplementation(async (node) => ({
      status: "supported",
      version: compatible || node === "/current/node" ? "26.1.0" : "24.16.0",
      sqliteVersion: "3.53.0",
      nodeSharedSqlite: false,
      sqliteProbe: { available: true, version: "3.53.0", text: true, blob: true, json: true },
    }));
    vi.mocked(packageMetadata.fetchNpmPackageTargetStatus).mockResolvedValue({
      ...targetMetadata,
      nodeEngine: ">=26.1.0",
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
    const preview = vi.mocked(defaultRuntime.writeJson).mock.calls.at(-1)?.[0];
    const notes = json ? JSON.stringify(preview) : log.mock.calls.flat().join("\n");
    const replacement = !compatible && restart && owned && (!current || (running && refresh));
    if (!compatible && !replacement) {
      const recoverySteps = [
        {
          kind: "preserve-context",
          instruction:
            "Use the same service account and keep the existing OPENCLAW_STATE_DIR and OPENCLAW_CONFIG_PATH overrides throughout recovery.",
        },
        {
          kind: "select-runtime",
          instruction:
            "Install and select Node 26.1.0 using your system package manager or https://nodejs.org/en/download.",
        },
        ...(current && (!running || !refresh)
          ? [
              {
                kind: "select-runtime",
                instruction:
                  "The Gateway service still selects /service/node. Before continuing, have its deployment owner select Node 26.1.0 in the service definition while retaining its installation, service account, and state/config selectors. Switching the shell runtime alone does not update that service definition.",
              },
            ]
          : []),
        {
          kind: "continue-update",
          command: `node ${process.platform === "win32" ? quotePowerShellArg(path.join(fixture.root, "openclaw.mjs")) : quoteCliArg(path.join(fixture.root, "openclaw.mjs"))} update --tag 2026.9.2`,
        },
      ];
      const message = [
        "openclaw@2026.9.2 requires Node >=26.1.0; selected runtime is Node 24.16.0 at /service/node.",
        "Recovery:",
        ...recoverySteps.map(
          (step, index) =>
            `${index + 1}. ${"command" in step ? `Run \`${step.command}\`.` : step.instruction}`,
        ),
      ].join("\n");
      if (json) {
        expect(preview).toMatchObject({
          notes: [`Would refuse update: ${message}`],
          failures: [
            {
              reason: "node-runtime-preflight",
              message,
              recoverySteps,
              failureFacts: [
                {
                  check: "node-runtime",
                  code: "node-runtime-preflight",
                  affectedKey: "engines.node",
                  message:
                    "Target package: openclaw@2026.9.2; Minimum Node engine: 26.1.0; Running Node: 24.16.0",
                },
              ],
            },
          ],
        });
      } else {
        expect(log).toHaveBeenCalledWith(`  - Would refuse update: ${message}`);
      }
    } else if (replacement) {
      expect(notes).toContain("/service/node");
      expect(notes).toContain("/current/node");
      expect(notes).toContain("Would replace");
    } else {
      expect(notes).not.toContain("Would refuse");
      expect(notes).not.toContain("Would replace");
    }
    if (json && (compatible || replacement)) {
      expect(preview).not.toHaveProperty("failures");
    }
    expect(packageUpdate.stagePackageInstallUpdate).not.toHaveBeenCalled();
    expect(fs.existsSync(fixture.databasePath)).toBe(false);
    expect(fs.readFileSync(path.join(fixture.root, "package.json"))).toEqual(manifest);

    if (!current) {
      await expect(
        updateCommand({ ...opts, json: true, admission: "installed" }),
      ).rejects.toBeInstanceOf(Error);
      if (compatible || replacement) {
        expect(packageUpdate.stagePackageInstallUpdate).toHaveBeenCalledWith(
          expect.objectContaining({ nodeRunner: replacement ? "/current/node" : "/service/node" }),
        );
      } else {
        expect(defaultRuntime.writeJson).toHaveBeenLastCalledWith(
          expect.objectContaining({
            reason: "node-runtime-preflight",
            steps: expect.arrayContaining([
              expect.objectContaining({
                stderrTail: expect.stringContaining(
                  `node ${process.platform === "win32" ? quotePowerShellArg(path.join(fixture.root, "openclaw.mjs")) : quoteCliArg(path.join(fixture.root, "openclaw.mjs"))} update --tag 2026.9.2`,
                ),
                failureFacts: [
                  expect.objectContaining({
                    code: "node-runtime-preflight",
                    message: expect.stringContaining("Minimum Node engine: 26.1.0"),
                  }),
                ],
              }),
            ]),
          }),
        );
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
      expect(defaultRuntime.writeJson).toHaveBeenLastCalledWith(
        expect.objectContaining({
          dryRun: true,
          failures: [
            expect.objectContaining({
              reason: "global-install-permission-denied",
              message: expect.stringContaining(globalRoot),
              failureFacts: [expect.objectContaining({ code: "global-install-permission-denied" })],
            }),
          ],
        }),
      );
      expect(packageUpdate.stagePackageInstallUpdate).not.toHaveBeenCalled();
      expect(fs.existsSync(fixture.databasePath)).toBe(false);
      expect(fs.readdirSync(globalRoot)).toEqual([]);
    } finally {
      fs.chmodSync(globalRoot, 0o755);
    }
  },
);
