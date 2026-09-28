import "./update-command-service-maintenance.test-support.js";
import path from "node:path";
import { stableStringify } from "@openclaw/normalization-core/stable-stringify";
import { expect, it } from "vitest";
import { readGatewayServiceState } from "../../daemon/service.js";
import { createMockGatewayService } from "../../daemon/service.test-helpers.js";
import { sha256Hex } from "../../infra/crypto-digest.js";
import { mockProcessPlatform } from "../../test-utils/vitest-spies.js";
import {
  revalidateManagedGatewayServiceAfterUpdate,
  type PreManagedServiceStop,
} from "./update-command-service-maintenance.js";

const { withServiceHome } = await import("./update-command-service-maintenance.test-support.js");

it.each([
  "shipped handoff",
  "shipped startup handoff",
  "shipped startup protected handoff",
  "matching UID",
  "mismatching UID",
  "unavailable manager",
  "different unit",
  "different profile",
  "foreign executable",
  "unchanged protected command",
  "changed protected command",
  "changed protected environment",
  "changed protected working directory",
  "changed protected override",
])("revalidates the shipped managed-service stop record: %s", (scenario) =>
  withServiceHome(async (home) => {
    mockProcessPlatform(scenario.includes("startup") ? "win32" : "linux");
    const root = process.cwd();
    const command = {
      programArguments: [process.execPath, path.join(root, "openclaw.mjs"), "gateway"],
      environment: { HOME: home },
      ...(scenario.includes("startup") ? { sourcePath: path.join(home, "gateway.cmd") } : {}),
    };
    const protectedCommand = scenario.includes("protected");
    const fingerprint = sha256Hex(stableStringify(command));
    // Stable updaters through v2026.9.4 omit metadata for known-empty systemd overrides.
    const before: PreManagedServiceStop = {
      stoppedAtMs: 1,
      stopped: true,
      inspected: true,
      runtimeInspected: true,
      running: true,
      offline: false,
      serviceEnv: { HOME: home },
      serviceDefinitionEnv: command.environment,
      serviceNodeRunner: process.execPath,
      serviceUpdateVerdict: {
        kind: "owned",
        root,
        fingerprint,
        refreshDefinition: !protectedCommand,
      },
    };
    if (scenario === "matching UID" || scenario === "mismatching UID") {
      before.serviceManagerUid = scenario === "matching UID" ? 2001 : 3002;
    }
    const service = createMockGatewayService({
      readCommand: async () => ({
        ...command,
        ...(scenario.includes("startup")
          ? { startupEntryPaths: [path.join(home, "Gateway.vbs")] }
          : {}),
        ...(protectedCommand
          ? {
              managedDefinition: command,
              managedOverrides:
                scenario === "changed protected override" ? { launcher: "command" as const } : {},
            }
          : {}),
        ...(scenario === "changed protected working directory" ? { workingDirectory: home } : {}),
        programArguments:
          scenario === "foreign executable"
            ? [process.execPath, path.join(home, "other", "openclaw.mjs"), "gateway"]
            : scenario === "changed protected command"
              ? [...command.programArguments, "--verbose"]
              : command.programArguments,
        environment: {
          ...command.environment,
          ...(scenario === "changed protected environment" ? { FIXTURE_VALUE: "changed" } : {}),
          ...(scenario === "different unit" ? { OPENCLAW_SYSTEMD_UNIT: "other-gateway" } : {}),
          ...(scenario === "different profile"
            ? {
                OPENCLAW_PROFILE: "other",
                OPENCLAW_STATE_DIR: path.join(home, ".openclaw-other"),
                OPENCLAW_CONFIG_PATH: path.join(home, ".openclaw-other", "openclaw.json"),
              }
            : {}),
        },
      }),
      readRuntime: async () => ({
        status: "stopped",
        systemd: { managerUid: scenario === "unavailable manager" ? undefined : 2001 },
      }),
      isLoaded: async () => true,
    });
    const state = await readGatewayServiceState(service, {
      env: before.serviceEnv,
      requireEffective: true,
      requireLoadedCommand: true,
    });
    const revalidated = revalidateManagedGatewayServiceAfterUpdate({
      state,
      root,
      preManagedServiceStop: before,
    });
    if (
      scenario.startsWith("shipped") ||
      scenario === "matching UID" ||
      scenario === "unchanged protected command"
    ) {
      await expect(revalidated).resolves.toMatchObject({
        kind: "owned",
        fingerprint,
        refreshDefinition: !protectedCommand,
      });
    } else {
      await expect(revalidated).rejects.toThrow(
        scenario === "unavailable manager"
          ? /inspection is unavailable/
          : /ownership or manager identity changed/,
      );
    }
  }),
);
