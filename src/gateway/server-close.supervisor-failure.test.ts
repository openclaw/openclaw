import { collectNestedErrorCandidates } from "@openclaw/normalization-core/error-coercion";
import { expect, it, vi } from "vitest";
import type { SqliteIntegrityDiagnostics } from "../infra/sqlite-integrity.js";
import { PluginRuntimeCloseRetainedError } from "../plugins/runtime-close-error.js";
import { resetGatewayWorkAdmission } from "../process/gateway-work-admission.js";
import * as supervisor from "../process/supervisor/index.js";
import * as schema from "../state/openclaw-agent-db-schema.js";
import { openOpenClawAgentDatabase } from "../state/openclaw-agent-db.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { createGatewayMetadataCloseFixture } from "./server-close.metadata.test-support.js";

it("closes agent databases after a settled supervisor failure without process-death recovery", async () => {
  const fixture = await createGatewayMetadataCloseFixture("gateway-supervisor-failure-close");
  try {
    const { server } = await fixture.startServer();
    const options = { agentId: "main", env: fixture.state.env };
    const agent = openOpenClawAgentDatabase(options);
    const shared = openOpenClawStateDatabase(options).db;
    const leases = shared.prepare("SELECT lease_id FROM agent_database_leases WHERE owner_pid = ?");
    expect(leases.all(process.pid)).not.toEqual([]);
    const failure = new PluginRuntimeCloseRetainedError(
      new Error("latched service-child cleanup failure"),
    );
    vi.spyOn(supervisor, "shutdownProcessSupervisor").mockRejectedValue(failure);
    const outcome = await server
      .close({ reason: "gateway restarting", exitAfterClose: true })
      .catch((error: unknown) => error);
    expect(collectNestedErrorCandidates(outcome)).toContain(failure);
    expect(leases.all(process.pid)).toEqual([]);
    expect(agent.db.isOpen).toBe(false);
    expect(shared.isOpen).toBe(true);
    const gate = schema.agentDatabaseIntegrityBeforeMutationSteps;
    let diagnostics: SqliteIntegrityDiagnostics | undefined;
    vi.spyOn(schema, "agentDatabaseIntegrityBeforeMutationSteps").mockImplementation(function* (
      ...args
    ) {
      diagnostics = args[3];
      return yield* gate(...args);
    });
    resetGatewayWorkAdmission();
    expect(openOpenClawAgentDatabase(options).db.isOpen).toBe(true);
    expect(diagnostics).toBeDefined();
    expect(diagnostics?.integrityGateReason).not.toBe("process-death");
  } finally {
    vi.restoreAllMocks();
    await fixture.cleanup();
  }
});
