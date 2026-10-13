import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GATEWAY_CLIENT_IDS,
  GATEWAY_CLIENT_MODES,
} from "../../packages/gateway-protocol/src/client-info.js";
import { markStartupOrphanedMainSessionsForRecovery } from "../agents/main-session-recovery/main-session-restart-recovery-marking.js";
import { recoverStore } from "../agents/main-session-recovery/main-session-restart-recovery-store.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import {
  appendTranscriptMessage,
  replaceSessionEntry,
} from "../config/sessions/session-accessor.js";
import { readSessionEntryReadOnlyInWorker } from "../config/sessions/session-entry-read-runtime.js";
import {
  resetAgentEventsForTest,
  rotateAgentEventLifecycleGeneration,
} from "../infra/agent-events.js";
import { trackAsyncWork } from "../shared/async-work-scope.js";
import { setUserProfileRole } from "../state/user-profile-writes.worker.js";
import { ensureGatewayOwnerProfile, ensureProfileForEmail } from "../state/user-profiles.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { cleanupSessionStateForTest } from "../test-utils/session-state-cleanup.js";
import type { createAgentTurnService } from "./agent-turn/agent-turn-service.js";
import { invalidateGatewayDeviceRevocation } from "./device-revocation.js";
import { createGatewayMethodRegistry } from "./methods/registry.js";
import { createOperatorRecoveryFixture } from "./operator-run-recovery.test-support.js";
import { createDirectChatContext } from "./server-chat.agent-events.test-helpers.js";
import { createGatewayInstanceRuntime } from "./server-instance-runtime.js";

const startTurn = vi.hoisted(() => vi.fn<ReturnType<typeof createAgentTurnService>["startTurn"]>());

// mock-isolation: Recovery reaches the real typed facade and restored authority;
// exclude unrelated request-envelope routing already covered by Gateway request tests.
vi.mock("./server-methods.js", () => ({
  createRequestGatewayMethodRegistry: () => ({ isControlPlaneWrite: () => false }),
  runWithGatewayRequestEnvelope: async (
    _method: string,
    _client: unknown,
    run: () => Promise<unknown>,
  ) => await run(),
}));
// mock-isolation: The restart-recovery owner and live operator restoration, rather
// than generic synthetic-request ingress, are the authorization boundary under test.
vi.mock("./server-methods/request-authorization.js", () => ({
  authorizeGatewayRequestPreDispatch: async () => ({ error: null }),
}));
// mock-isolation: No model preparation is needed for the guarded sentinel effect.
vi.mock("./agent-turn/agent-request-preflight.js", () => ({
  prepareAgentRequestPreflight: ({ request }: { request: unknown }) => ({ request }),
}));
// mock-isolation: Substitute only provider execution with a sentinel at the final
// authority guard; capture, SQLite reload, startup marking and dispatch remain real.
vi.mock("./agent-turn/agent-turn-service.js", () => ({
  createAgentTurnService: () => ({ startTurn, waitForTurn: vi.fn() }),
}));

afterEach(() => {
  startTurn.mockReset();
  resetAgentEventsForTest();
});

describe("cold restart recovery of native operator input", () => {
  it.each([
    "native source",
    "native steering",
    "Control UI source",
    "unowned delegated source",
    "device revoked after admission",
    "role reassigned after admission",
  ] as const)("guards sentinel effects for %s", async (scenario) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      setRuntimeConfigSnapshot({});
      const owner =
        scenario === "role reassigned after admission"
          ? ensureProfileForEmail("native-recovery-operator@example.test")
          : ensureGatewayOwnerProfile("Recovery owner");
      const fixture = await createOperatorRecoveryFixture({
        stateDir: state.stateDir,
        context: createDirectChatContext({ trackExecution: trackAsyncWork }),
        profileId: owner.id,
        config: {},
        clientInfo:
          scenario === "Control UI source"
            ? { id: GATEWAY_CLIENT_IDS.CONTROL_UI, mode: GATEWAY_CLIENT_MODES.WEBCHAT }
            : { id: GATEWAY_CLIENT_IDS.MACOS_APP, mode: GATEWAY_CLIENT_MODES.UI },
        localOperator: true,
        device: {
          deviceId: "native-recovery-device",
          publicKey: "synthetic-public-key",
          roles: ["operator"],
          approvedScopes: ["operator.admin"],
          tokens: {
            operator: {
              token: "synthetic-device-token",
              role: "operator",
              scopes: ["operator.admin"],
              createdAtMs: 1,
            },
          },
          createdAtMs: 1,
          approvedAtMs: 1,
        },
      });
      expect(fixture.sourceAuthority.assertCurrent).toThrow("no longer active");
      expect(fixture.entry.restartRecoverySourceIngress).toBe(
        scenario === "Control UI source" ? "control-ui" : "internal",
      );
      await replaceSessionEntry(fixture.target, {
        ...fixture.entry,
        status: "interrupted",
        lifecycleRunId: fixture.target.sourceRunId,
        restartRecoveryOperatorSource:
          scenario === "unowned delegated source"
            ? undefined
            : fixture.entry.restartRecoveryOperatorSource,
      });
      const messages = [
        { role: "user", content: "Finish the synthetic task", timestamp: 1 },
        ...(scenario === "native steering"
          ? [{ role: "user", content: "Also check its result", timestamp: 2 }]
          : []),
        { role: "assistant", content: [], stopReason: "aborted", timestamp: 3 },
      ];
      for (const message of messages) {
        await appendTranscriptMessage(fixture.target, { cwd: state.workspaceDir, message });
      }

      // Dispose old SQLite handles and process-lifetime owners. A fresh context
      // must restore only the durable claim, never the closed original capability.
      await cleanupSessionStateForTest({ stateDir: state.stateDir });
      rotateAgentEventLifecycleGeneration();
      const context = createDirectChatContext({ trackExecution: trackAsyncWork });
      const runtime = createGatewayInstanceRuntime({
        getContext: () => context,
        getMethodRegistry: () => createGatewayMethodRegistry([]),
        isDispatchAvailable: () => true,
      });
      let sentinelEffects = 0;
      startTurn.mockImplementation(async ({ principal, assertAdmissionCurrent, io }) => {
        const authority = expectDefined(
          principal?.internal?.operatorRunAuthority,
          "restored owner",
        );
        expect(authority.profileId).toBe(owner.id);
        if (scenario === "device revoked after admission") {
          invalidateGatewayDeviceRevocation(context, "native-recovery-device", "operator");
        } else if (scenario === "role reassigned after admission") {
          setUserProfileRole(owner.id, "replacement-role");
        }
        assertAdmissionCurrent?.();
        authority.assertCurrent();
        sentinelEffects++;
        io.emitAcceptance([true, { runId: fixture.target.recoveryRunId, status: "ok" }, undefined]);
        io.emitFinal([true, { runId: fixture.target.recoveryRunId, status: "ok" }, undefined]);
      });
      try {
        await expect(
          markStartupOrphanedMainSessionsForRecovery({ stateDir: state.stateDir, cfg: {} }),
        ).resolves.toMatchObject({ marked: 1, skipped: 0 });
        const result = await recoverStore({
          storeAgentId: "main",
          storePath: fixture.target.storePath,
          stateDir: state.stateDir,
          cfg: {},
          handledSessionKeys: new Set(),
          gatewayRuntime: runtime.recovery,
        });
        if (scenario === "unowned delegated source") {
          expect(result).toEqual({ started: 0, settled: 0, failed: 0, skipped: 1 });
          expect(startTurn).not.toHaveBeenCalled();
          const entry = await readSessionEntryReadOnlyInWorker(fixture.target);
          expect(entry?.mainRestartRecovery?.tombstone).toBeDefined();
        } else if (scenario.includes("after admission")) {
          expect(result).toEqual({ started: 0, settled: 0, failed: 1, skipped: 0 });
          expect(startTurn).toHaveBeenCalledOnce();
        } else {
          expect(result).toEqual({ started: 0, settled: 1, failed: 0, skipped: 0 });
          expect(startTurn).toHaveBeenCalledOnce();
        }
        expect(sentinelEffects).toBe(
          scenario === "unowned delegated source" || scenario.includes("after admission") ? 0 : 1,
        );
      } finally {
        runtime.close();
      }
    });
  });
});
