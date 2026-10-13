import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
// @vitest-environment node
import { expect, it, vi } from "vitest";
import {
  resolveSessionRowProjection,
  type SessionRowProjection,
} from "../../../../packages/gateway-protocol/src/session-row-fields.js";
import type { GatewaySessionRow } from "../../api/types.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import {
  createGatewayHarness,
  createTestSessionCapability,
  sessionsResult,
} from "./session-capability.test-support.ts";

it.each([true, false])(
  "requests selected sidebar fields only with the advertised capability (%s)",
  async (enabled) => {
    const request = vi.fn(async (_method: string, _params?: unknown) => sessionsResult([], 1));
    const { gateway } = createGatewayHarness(createTestGatewayClient(request), ["sessions.list"]);
    if (gateway.snapshot.hello?.features) {
      gateway.snapshot.hello.features.capabilities = enabled ? ["sessions.rowFields"] : [];
    }
    const sessions = createTestSessionCapability(gateway);
    await sessions.refresh({ force: true, rowMode: "sidebar" });
    const list = request.mock.calls.find(([method]) => method === "sessions.list");
    if (enabled) {
      expect(list?.[1]).toMatchObject({
        fields: expect.arrayContaining(["label", "participants", "owner", "childSessions"]),
      });
      expect(list?.[1]).not.toHaveProperty("rowMode");
    } else {
      expect(list?.[1]).toMatchObject({ rowMode: "sidebar" });
      expect(list?.[1]).not.toHaveProperty("fields");
    }
    sessions.dispose();
  },
);

it("keeps descriptor and event facts separate by their declared coverage", async () => {
  const key = "agent:main:projected";
  const full: GatewaySessionRow = {
    key,
    kind: "direct",
    sessionId: "projected-session",
    updatedAt: 1,
    label: "Earlier title",
    model: "fixture-model",
    owner: { actor: { type: "human", id: "fixture-owner" } },
    archived: false,
  };
  const labelProjection = resolveSessionRowProjection({ fields: ["label"] })!;
  const selected: GatewaySessionRow = {
    key,
    kind: "direct",
    sessionId: full.sessionId,
    updatedAt: 2,
    rowMode: "fields",
    rowProjectionId: labelProjection.id,
    label: "Current title",
  };
  const descriptions = vi.fn(
    async (
      _params?: unknown,
    ): Promise<{
      session: GatewaySessionRow;
      rowProjection?: SessionRowProjection;
    }> => ({ session: selected, rowProjection: labelProjection }),
  );
  const client = createTestGatewayClient(async (method, params) => {
    if (method === "sessions.describe") {
      return descriptions(params);
    }
    if (method === "sessions.list") {
      return asOptionalRecord(params)?.fields
        ? { ...sessionsResult([selected], 2), rowProjection: labelProjection }
        : sessionsResult([full], 1);
    }
    return { subscribed: true };
  });
  const h = createGatewayHarness(client);
  const sessions = createTestSessionCapability(h.gateway);
  await sessions.refresh({ force: true, rowMode: "compact" });
  await sessions.refresh({ force: true, fields: ["label"] });
  expect(sessions.state.result?.sessions[0]).toMatchObject({
    label: "Current title",
    model: "fixture-model",
    owner: { actor: { type: "human", id: "fixture-owner" } },
  });
  const narrow = await sessions.describe({ key, fields: ["label"] });
  sessions.reconcile(narrow.session ?? undefined);
  expect(sessions.state.result?.sessions[0]).toMatchObject({
    label: "Current title",
    model: "fixture-model",
    owner: { actor: { type: "human", id: "fixture-owner" } },
  });
  descriptions.mockResolvedValueOnce({ session: { ...full, updatedAt: 2 } });
  await sessions.describe({ key });
  expect(descriptions).toHaveBeenCalledTimes(2);

  const ownerProjection = resolveSessionRowProjection({ fields: ["owner"] })!;
  h.emitEvent({
    type: "event",
    event: "sessions.changed",
    payload: {
      sessionKey: key,
      agentId: "main",
      reason: "participants",
      rowProjection: ownerProjection,
      ancestorSessions: [],
      session: {
        key,
        kind: "direct",
        sessionId: full.sessionId,
        updatedAt: 3,
        rowMode: "fields",
        rowProjectionId: ownerProjection.id,
      },
    },
  });
  const current = sessions.state.result?.sessions[0];
  expect(current?.owner).toBeUndefined();
  expect(current?.label).toBe("Current title");
  expect(current?.model).toBe("fixture-model");
  h.emitEvent({
    type: "event",
    event: "sessions.changed",
    payload: {
      sessionKey: key,
      agentId: "main",
      reason: "patch",
      sessionId: full.sessionId,
      updatedAt: 4,
      label: "Delta title",
      model: null,
    },
  });
  expect(sessions.state.result?.sessions[0]?.label).toBe("Delta title");
  expect(sessions.state.result?.sessions[0]?.model).toBeUndefined();
  expect(sessions.state.result?.sessions[0]?.owner).toBeUndefined();
  sessions.dispose();
});
