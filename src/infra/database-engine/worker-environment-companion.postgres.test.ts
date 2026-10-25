import { describe, expect, it } from "vitest";
import { createWorkerEnvironmentStore } from "../../gateway/worker-environments/store.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import * as operationAdmission from "../sqlite-worker-operation-admission.js";
import { sqliteWorkerOwnerProbe } from "../sqlite-worker-owner-probe.test-support.js";
import { withEngineStoreAdmission as admit } from "./admission-scope.js";
import { mixedAgentConnection, useMixedAgentPair } from "./mixed-agent.conformance.test-support.js";

describe.skipIf(!mixedAgentConnection)("PostgreSQL worker environment companion schema", () => {
  useMixedAgentPair("postgres", "postgres");

  it("rolls back refused first-use schema preparation and retries through the worker", async () => {
    const database = admit(() => openOpenClawStateDatabase());
    const relation = () =>
      admit(() =>
        database.db
          .prepare("SELECT to_regclass('worker_environment_session_attachments')::text AS relation")
          .get(),
      );
    expect(relation()).toEqual({ relation: null });

    let refusedCommit = false;
    using refusal = sqliteWorkerOwnerProbe.admission(
      operationAdmission,
      (request, grant, admitRequest) => {
        // Cold opening has its own admission; the inventory commit carries an array of facts.
        if (request.stage === "commit" && Array.isArray(request.facts)) {
          refusedCommit = true;
          throw new Error("companion schema commit refused");
        }
        admitRequest(request, grant);
      },
    );
    await expect(createWorkerEnvironmentStore({ database })).rejects.toThrow(
      "companion schema commit refused",
    );
    expect(refusedCommit).toBe(true);
    refusal.mockRestore();
    expect(relation()).toEqual({ relation: null });

    let store = await createWorkerEnvironmentStore({ database });
    try {
      await store.createSessionAttachmentIntent(
        {
          environmentId: "companion-environment",
          providerId: "synthetic-provider",
          profileId: "synthetic-profile",
          profileSnapshot: { settings: {} },
          provisionOperationId: "companion-provision",
          sessionId: "companion-session",
          sessionKey: "agent:main:companion-session",
          agentId: "main",
        },
        () => {},
      );
      await store.close();
      store = await createWorkerEnvironmentStore({ database });
      expect(store.getSessionAttachmentRecord("companion-session")).toMatchObject({
        sessionId: "companion-session",
        sessionKey: "agent:main:companion-session",
        environmentId: "companion-environment",
        generation: 1,
        closedAtMs: null,
      });
    } finally {
      await store.close();
    }
  });
});
