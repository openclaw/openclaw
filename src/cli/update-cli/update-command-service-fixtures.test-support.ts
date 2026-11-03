import fs from "node:fs/promises";
import path from "node:path";
import type { Mock } from "vitest";
import type { HelloOk } from "../../../packages/gateway-protocol/src/schema/frames.js";
import type { UpdateCommandOptions } from "./shared.js";

export type InstallRootTransitionFixture = {
  root: string;
  run: NonNullable<UpdateCommandOptions["run"]>;
  mocks: {
    running: boolean;
    events: string[];
    command: Mock<typeof import("../../daemon/systemd.js").readSystemdServiceExecStart>;
    capability: Mock<
      typeof import("../../daemon/systemd-definition-mutation.js").readSystemdDefinitionMutationCapability
    >;
    child: Mock<typeof import("../../process/exec.js").runCommandWithTimeout>;
    health: Mock<typeof import("../daemon-cli/restart-health.js").waitForGatewayHealthyRestart>;
    configSnapshot: Mock;
  };
};

export const maintenanceDefaults = {
  root: process.cwd(),
  updateInstallKind: "package" as const,
  shouldRestart: true,
  jsonMode: true,
};

export function gatewayCommand(home: string, root = process.cwd()) {
  return {
    programArguments: [process.execPath, path.join(root, "openclaw.mjs"), "gateway"],
    environment: { HOME: home },
  };
}

export async function writeHandoffMeta(
  home: string,
  root: string,
  runId: string,
  handoffId: string,
) {
  const pathname = path.join(home, "handoff-meta.json");
  await fs.writeFile(pathname, JSON.stringify({ version: 1, meta: { root, runId, handoffId } }));
  return pathname;
}

export function commandResult(stdout = "", code = 0, stderr = "") {
  return { code, stdout, stderr };
}

export function nativeResult(stdout = "", code = 0, stderr = "") {
  return { ...commandResult(stdout, code, stderr), termination: "exit" as const };
}

export function gatewayHello(bootId: string, connId = "fixture"): HelloOk {
  return {
    type: "hello-ok",
    protocol: 3,
    server: { version: "fixture", connId, bootId },
    features: { methods: [], events: [] },
    snapshot: { presence: [], health: {}, stateVersion: { presence: 0, health: 0 }, uptimeMs: 0 },
    auth: { role: "operator", scopes: ["operator.admin"] },
    policy: { maxPayload: 1_000_000, maxBufferedBytes: 1_000_000, tickIntervalMs: 60_000 },
  };
}
