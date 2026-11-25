import { describe, expect, it } from "vitest";
import {
  createSessionEntryWithTranscript,
  loadSessionEntry,
} from "../../config/sessions/session-accessor.js";
import { readSessionCreationReceiptInWorker } from "../../config/sessions/session-creation-receipt-read.js";
import {
  closeOpenClawAgentDatabasesAsync,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { withEngineStoreAdmission } from "./admission-scope.js";
import { mixedAgentConnection, useMixedAgentPair } from "./mixed-agent.conformance.test-support.js";

describe.skipIf(!mixedAgentConnection)("PostgreSQL session creation receipts", () => {
  // This contract owns the agent writer; shared-state bootstrap is qualified separately.
  useMixedAgentPair("sqlite", "postgres");
  it("reopens the exact creation receipt and rolls back a competing row in its worker", async () => {
    const { path: storePath } = withEngineStoreAdmission(() =>
      openOpenClawAgentDatabase({ agentId: "main" }),
    );
    const scope = { agentId: "main", storePath };
    const operation = {
      digest: "postgres-creation",
      fingerprint: "original",
      authorization: { role: "operator", scopes: ["operator.write"] },
    };
    const create = (sessionKey: string) =>
      createSessionEntryWithTranscript(
        { ...scope, sessionKey },
        () => ({
          ok: true,
          entry: {
            sessionId: sessionKey,
            lifecycleRevision: "first-incarnation",
            updatedAt: Date.now(),
          },
        }),
        { creationOperation: operation },
      );
    const key = "agent:main:postgres-original";
    expect(await create(key)).toMatchObject({ ok: true });
    await closeOpenClawAgentDatabasesAsync();
    expect(
      await readSessionCreationReceiptInWorker(scope, operation.digest, () => {}),
    ).toMatchObject({
      receipt: { sessionKey: key, sessionId: key, lifecycleRevision: "first-incarnation" },
    });
    const competing = "agent:main:postgres-competing";
    await expect(create(competing)).rejects.toThrow();
    expect(
      withEngineStoreAdmission(() => loadSessionEntry({ ...scope, sessionKey: competing })),
    ).toBeUndefined();
  });
});
