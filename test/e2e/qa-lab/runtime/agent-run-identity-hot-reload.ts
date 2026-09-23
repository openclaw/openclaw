import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { QaGatewayChild } from "../../../../extensions/qa-lab/src/gateway-child.js";
import type { AuditRunInspectResult } from "../../../../packages/gateway-protocol/src/index.js";
import {
  connectHotReloadClient,
  waitForHotReloadFact,
  type HotReloadConnection,
} from "./gateway-config-hot-reload-fixtures.js";

export async function runIdentityGatewayTurn(gateway: QaGatewayChild, label: string) {
  const accepted = (await gateway.call(
    "agent",
    {
      sessionKey: `agent:qa:identity-hot-${randomUUID()}`,
      message: `Reply exactly: ${label}`,
      deliver: false,
      idempotencyKey: randomUUID(),
    },
    { expectFinal: false },
  )) as { status: string; runId: string };
  assert.equal(accepted.status, "accepted");
  assert.equal(typeof accepted.runId, "string");
  const terminal = (await gateway.call(
    "agent.wait",
    { runId: accepted.runId, timeoutMs: 60_000 },
    { timeoutMs: 65_000 },
  )) as { status: string };
  assert.equal(terminal.status, "ok", `${label} must complete through the real Gateway`);
  return accepted.runId;
}

export async function patchExecutionIdentity(
  gateway: QaGatewayChild,
  connection: HotReloadConnection,
  values: { enabled?: boolean; executionIdentity: boolean },
) {
  const pid = gateway.pid;
  const bootId = connection.bootId;
  const snapshot = await connection.client.request<{ hash: string }>("config.get", {});
  // config.patch acknowledges the runtime application, not merely the file write.
  const applied = await connection.client.request<{
    sentinel: { payload: { stats: { requiresRestart: boolean } } };
  }>("config.patch", {
    baseHash: snapshot.hash,
    raw: JSON.stringify({ logging: { audit: values } }),
  });
  assert.equal(applied.sentinel.payload.stats.requiresRestart, false);
  assert.equal((await connection.client.request<{ pid: number }>("system.info", {})).pid, pid);
  assert.equal(connection.hellos, 1, "hot audit changes must retain the connected socket");
  assert.equal(connection.closes, 0, "hot audit changes must not disconnect operators");
  const fresh = await connectHotReloadClient(gateway);
  try {
    assert.equal(fresh.bootId, bootId, "hot audit changes must retain the same Gateway boot");
  } finally {
    await fresh.client.stopAndWait({ timeoutMs: 2_000 });
  }
}

export async function waitForIdentityAuditFence(gateway: QaGatewayChild, runId: string) {
  return waitForHotReloadFact(`identity and terminal activity for ${runId}`, async () => {
    const result = (await gateway.call("audit.run.inspect", { runId })) as AuditRunInspectResult;
    const activity = (await gateway.call("audit.activity.list", { runId })) as {
      events: Array<{ action: string }>;
    };
    return result.identity.state === "present" &&
      activity.events.some((event) => event.action === "agent.run.finished")
      ? result.identity.context
      : undefined;
  });
}

export async function proveHotExecutionIdentity(gateway: QaGatewayChild) {
  const connection = await connectHotReloadClient(gateway);
  const inspect = (runId: string) =>
    connection.client.request<AuditRunInspectResult>("audit.run.inspect", { runId });
  const present = (runId: string) =>
    waitForHotReloadFact(`persisted identity for ${runId}`, async () => {
      const result = await inspect(runId);
      return result.identity.state === "present" ? result.identity.context : undefined;
    });
  try {
    const beforeEnable = await runIdentityGatewayTurn(gateway, "HOT-DEFAULT-OFF");
    await patchExecutionIdentity(gateway, connection, { executionIdentity: true });
    const enabled = await runIdentityGatewayTurn(gateway, "HOT-ENABLED");
    const retained = await present(enabled);
    assert.equal(retained.runId, enabled);

    await patchExecutionIdentity(gateway, connection, { executionIdentity: false });
    const whileDisabled = await runIdentityGatewayTurn(gateway, "HOT-DISABLED");
    assert.deepEqual(await present(enabled), retained, "disable must retain immutable evidence");

    await patchExecutionIdentity(gateway, connection, { executionIdentity: true });
    const reenabled = await runIdentityGatewayTurn(gateway, "HOT-REENABLED");
    const next = await present(reenabled);
    assert.notEqual(next.executionId, retained.executionId);
    assert.notEqual(next.contextId, retained.contextId);
    // The later positive write settles the same audit FIFO. Earlier disabled
    // admissions must remain without identity after both enabling transitions.
    for (const runId of [beforeEnable, whileDisabled]) {
      const result = await inspect(runId);
      assert.equal(result.identity.state, "unsupported", "enabling must not backfill a run");
      assert.deepEqual(result.decisionDisplays, []);
    }
    assert.deepEqual(await present(enabled), retained, "reenable must not rewrite an old context");
    return {
      bootId: connection.bootId,
      pid: gateway.pid,
      beforeEnable,
      enabled,
      whileDisabled,
      reenabled,
      noBackfill: true,
      retainedContextUnchanged: true,
    };
  } finally {
    await connection.client.stopAndWait({ timeoutMs: 2_000 });
  }
}
