import type { Mock } from "vitest";
import type { GatewayActiveWorkSnapshot } from "../../infra/gateway-active-work.js";
import type { GatewayBootLifecycleCompletion } from "../../infra/gateway-boot-lifecycle.js";
import type { GatewayRestartIntent } from "../../infra/restart-intent.js";
import type {
  createRuntimeWithExitSignal,
  createSignaledStart,
  UpdateRespawnFixtures,
} from "./run-loop.test-support.js";

export type RequestFixtures = {
  createSignaledLoopHarness: UpdateRespawnFixtures["createSignaledLoopHarness"];
  createGatewayActiveWorkSnapshot: Mock<() => GatewayActiveWorkSnapshot>;
  abortActiveCronTaskRuns: Mock<(_reason?: string) => number>;
  acquireGatewayLock: Mock<
    (opts?: { port?: number }) => Promise<{ release: Mock<() => Promise<void>> }>
  >;
  runLoopWithStart: (params: {
    start: ReturnType<typeof createSignaledStart>["start"];
    runtime: ReturnType<typeof createRuntimeWithExitSignal>["runtime"];
    ownsProcessLifecycle?: boolean;
    beginBoot?: (startedAtMs: number) => void | Promise<void>;
    completeBoot?: (completion: GatewayBootLifecycleCompletion) => void;
  }) => Promise<unknown>;
  waitForGatewayActiveWork: Mock<
    typeof import("../../infra/gateway-active-work.js").waitForGatewayActiveWork
  >;
  restartGatewayProcessWithFreshPid: Mock<
    typeof import("../../infra/process-respawn.js").restartGatewayProcessWithFreshPid
  >;
  respawnGatewayProcessForUpdate: UpdateRespawnFixtures["respawnGatewayProcessForUpdate"];
  captureForegroundUpdateHandoffStop: UpdateRespawnFixtures["captureForegroundUpdateHandoffStop"];
  readCgroup: Mock;
  systemctl: Mock;
  armShutdownHardExitWatchdog: Mock;
  cancelShutdownHardExitWatchdog: Mock;
  consumeGatewayRestartIntent: Mock<() => GatewayRestartIntent | null>;
  consumeGatewayRestartIntentPayloadSync: Mock<
    () => Pick<GatewayRestartIntent, "reason" | "force" | "waitMs"> | null
  >;
  peekGatewayRestartReason: Mock<() => string | undefined>;
  managedUpdateSuccessorOwner: NonNullable<GatewayRestartIntent["successorOwner"]>;
  commitManagedServiceUpdateHandoff: Mock<
    typeof import("../../infra/update-managed-service-handoff.js").commitManagedServiceUpdateHandoff
  >;
  waitForSystemServiceUpdateHandoffs: Mock<() => Promise<void> | undefined>;
  isGatewayWorkAdmissionClosed: () => boolean;
  gatewayLog: { info: Mock; warn: Mock; error: Mock };
};
