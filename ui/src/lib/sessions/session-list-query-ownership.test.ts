import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { describe, expect, it, vi } from "vitest";
import type { GatewaySessionRow } from "../../api/types.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import {
  createGatewayHarness,
  createTestSessionCapability,
  sessionsResult,
} from "./session-capability.test-support.ts";
import type { SessionListOptions, SessionListSnapshot } from "./session-capability.ts";

describe("session list replacement options", () => {
  it.each(["unfiltered", "excludeSubagents", "excludeCron", "excludeSystem"] as const)(
    "keeps list and subscription membership scoped for %s",
    async (flag) => {
      const ordinary: GatewaySessionRow = {
        key: "agent:main:ordinary",
        agentId: "main",
        sessionId: "ordinary-session",
        kind: "direct",
        updatedAt: 1,
      };
      const excluded: GatewaySessionRow = {
        key:
          flag === "excludeSubagents"
            ? "agent:main:subagent:worker"
            : flag === "excludeCron"
              ? "agent:main:cron:scheduled"
              : "agent:main:system:maintenance",
        agentId: "main",
        sessionId: "excluded-session",
        kind: "direct",
        updatedAt: 1,
      };
      let primaryRows = [ordinary, excluded];
      let issued = 0;
      const request = vi.fn(async (method: string, params?: unknown) => {
        if (method !== "sessions.list") {
          throw new Error(`Unexpected request: ${method}`);
        }
        const filtered = flag !== "unfiltered" && asOptionalRecord(params)?.[flag] === true;
        return sessionsResult(filtered ? [ordinary] : primaryRows, ++issued);
      });
      const { gateway } = createGatewayHarness(createTestGatewayClient(request));
      const sessions = createTestSessionCapability(gateway);
      const query: SessionListOptions = { agentId: "main" };
      if (flag !== "unfiltered") {
        query[flag] = true;
      }
      const updates = vi.fn<(snapshot: SessionListSnapshot) => void>();
      const stop = sessions.subscribeList(query, updates);
      const descriptor = sessions.observeRow({ key: excluded.key, agentId: "main" }, () => {});
      try {
        await sessions.refresh({ agentId: "main", force: true });
        const primaryBefore = sessions.state.result;
        const canonicalRevision = sessions.canonicalListRevision;
        const heldDescriptor = descriptor.row;
        expect(heldDescriptor).toMatchObject(excluded);
        updates.mockClear();

        const result = await sessions.list(query);
        const expectedRows = flag === "unfiltered" ? primaryRows : [ordinary];
        expect(request.mock.calls.at(-1)?.[1]).toMatchObject(query);
        expect(result?.sessions).toEqual(expectedRows);
        expect(sessions.state.result).toBe(primaryBefore);
        expect(updates).not.toHaveBeenCalled();

        await sessions.refreshList({ ...query, force: true });
        expect(updates.mock.calls.at(-1)?.[0].result?.sessions).toEqual(expectedRows);
        const queryWindow = sessions.listSnapshot(query).result;
        expect(queryWindow?.sessions).toEqual(expectedRows);
        expect(descriptor.isCurrent()).toBe(true);
        expect(descriptor.row).toBe(heldDescriptor);
        if (flag === "unfiltered") {
          expect(queryWindow).toBe(sessions.state.result);
          expect(sessions.canonicalListRevision).toBe(canonicalRevision + 1);
        } else {
          expect(sessions.state.result).toBe(primaryBefore);
          expect(sessions.state.result?.sessions).toEqual(primaryRows);
          expect(sessions.canonicalListRevision).toBe(canonicalRevision);
          expect(queryWindow).not.toBe(primaryBefore);
        }

        updates.mockClear();
        primaryRows = [
          ...primaryRows,
          { ...ordinary, key: "agent:main:later", sessionId: "later-session" },
        ];
        await sessions.refresh({ agentId: "main", force: true });
        expect(sessions.state.result?.sessions).toEqual(primaryRows);
        if (flag === "unfiltered") {
          expect(updates.mock.calls.at(-1)?.[0].result).toBe(sessions.state.result);
          expect(sessions.listSnapshot(query).result).toBe(sessions.state.result);
        } else {
          expect(updates).not.toHaveBeenCalled();
          expect(sessions.listSnapshot(query).result).toBe(queryWindow);
          expect(sessions.listSnapshot(query).result?.sessions).toEqual([ordinary]);
        }
      } finally {
        descriptor.dispose();
        stop();
        sessions.dispose();
      }
    },
  );
});
