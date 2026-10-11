import { expect, vi } from "vitest";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import { writeSessionEntry } from "../../config/sessions/session-accessor.sqlite-entry-store.js";
import { resetSystemEventsForTest } from "../../infra/system-events.js";
import * as gatewayWork from "../../process/gateway-work-admission.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { normalizeSessionDeliveryState } from "../../utils/delivery-context.shared.js";

export const continuation = vi.spyOn(gatewayWork, "runWithGatewayDetachedWorkContinuation");
export const sessionKey = "agent:main:event-origin";
export const route = {
  channel: "telegram",
  to: "-100001",
  accountId: "event-account",
  threadId: "42",
};

export async function withTargetFixture(
  run: (fixture: OpenClawTestState & { storePath: string }) => Promise<void>,
  options: { empty?: boolean; native?: boolean } = {},
) {
  await withOpenClawTestState(
    {
      label: "session-event-target",
      ...(options.native ? { env: { OPENCLAW_TEST_FAST: "0" } } : {}),
    },
    async (state) => {
      setRuntimeConfigSnapshot({ agents: { entries: { main: {} } } });
      openOpenClawStateDatabase({ env: state.env });
      if (!options.empty) {
        const database = openOpenClawAgentDatabase({ agentId: "main", env: state.env });
        writeSessionEntry(database, sessionKey, {
          sessionId: "original-session",
          lifecycleRevision: "original-revision",
          updatedAt: 1,
          delivery: normalizeSessionDeliveryState({ context: route }),
          permissionMode: "full",
        });
      }
      const storePath = resolveSessionStorePathCore(undefined, { agentId: "main", env: state.env });
      try {
        await run({ ...state, storePath });
      } finally {
        resetSystemEventsForTest();
        gatewayWork.resetGatewayWorkAdmission();
        await Promise.allSettled(
          continuation.mock.results.flatMap((result) =>
            result.type === "return" ? [result.value] : [],
          ),
        );
        expect(gatewayWork.getActiveGatewayRootWorkCount()).toBe(0);
      }
    },
  );
}
