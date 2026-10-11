import { collectNestedErrorCandidates } from "@openclaw/normalization-core/error-coercion";
import { expect, it, vi } from "vitest";
import * as preparedModelRuntimeLifecycle from "../agents/prepared-model-runtime.lifecycle.js";
import { assertNoOpenClawAgentDatabaseLeasesReadOnly } from "../state/openclaw-agent-db-lease.js";
import { openOpenClawAgentDatabase } from "../state/openclaw-agent-db.js";
import { readOpenClawAgentIntegrityVerification } from "../state/openclaw-quarantine-store.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { createGatewayMetadataCloseFixture } from "./server-close.metadata.test-support.js";

// The failed close permanently fences this process's metadata owner, so this file runs alone.
it("releases agent leases with clean receipts when an earlier final close step fails", async () => {
  const fixture = await createGatewayMetadataCloseFixture("gateway-agent-close-model-failure");
  try {
    const server = await fixture.start(await fixture.reservePort());
    const agent = openOpenClawAgentDatabase({ agentId: "main", env: fixture.state.env });
    const leases = openOpenClawStateDatabase({ env: fixture.state.env }).db.prepare(
      "SELECT lease_id FROM agent_database_leases WHERE path = ?",
    );
    expect(leases.all(agent.path)).toHaveLength(1);
    const failure = new Error("prepared model runtime close failed");
    vi.spyOn(preparedModelRuntimeLifecycle, "closePreparedModelRuntimeSnapshots").mockRejectedValue(
      failure,
    );

    const outcome = await server.close({ reason: "gateway stopping" }).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(collectNestedErrorCandidates(outcome)).toContain(failure);
    expect(agent.db.isOpen).toBe(false);
    expect(() =>
      assertNoOpenClawAgentDatabaseLeasesReadOnly({ env: fixture.state.env }),
    ).not.toThrow();
    expect(readOpenClawAgentIntegrityVerification(agent.path, fixture.state.env)?.clean_close).toBe(
      1,
    );
  } finally {
    vi.restoreAllMocks();
    await fixture.cleanup();
  }
});
