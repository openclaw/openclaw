import { expect, it } from "vitest";
import {
  closeOpenClawAgentDatabasesAsync,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createSessionEntryWithTranscript, loadSessionEntry } from "./session-accessor.js";
import { readSessionCreationReceiptInWorker } from "./session-creation-receipt-read.js";

it("commits the receipt with its original incarnation and rolls back a competing creation", () =>
  withOpenClawTestState({ scenario: "minimal" }, async () => {
    const { path: storePath } = openOpenClawAgentDatabase({ agentId: "main" });
    const operation = {
      digest: "creation-once",
      fingerprint: "original",
      authorization: { role: "operator", scopes: ["operator.write"] },
    };
    const scope = { agentId: "main", storePath };
    const lookup = () => readSessionCreationReceiptInWorker(scope, operation.digest, () => {});
    expect(await lookup()).toBeUndefined();
    const create = (key: string, sessionId: string) =>
      createSessionEntryWithTranscript(
        { ...scope, sessionKey: key },
        () => ({
          ok: true,
          entry: { sessionId, lifecycleRevision: "incarnation-one", updatedAt: Date.now() },
        }),
        { creationOperation: operation },
      );
    const key = "agent:main:receipt-original";
    expect(await create(key, "original-id")).toMatchObject({ ok: true });
    await closeOpenClawAgentDatabasesAsync();
    expect(await lookup()).toMatchObject({
      receipt: { sessionKey: key, sessionId: "original-id", lifecycleRevision: "incarnation-one" },
      entry: { sessionId: "original-id" },
    });
    const competingKey = "agent:main:receipt-competing";
    await expect(create(competingKey, "competing-id")).rejects.toThrow();
    expect(loadSessionEntry({ ...scope, sessionKey: competingKey })).toBeUndefined();
    expect(await lookup()).toMatchObject({
      receipt: { sessionKey: key, sessionId: "original-id" },
    });
  }));
