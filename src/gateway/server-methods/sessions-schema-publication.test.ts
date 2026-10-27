import { afterEach, expect, test, vi } from "vitest";
import { loadSessionEntry } from "../../config/sessions/session-accessor.js";
import { resolveSqliteTargetFromSessionStorePath } from "../../config/sessions/session-sqlite-target.js";
import * as validationCache from "../../state/openclaw-agent-db-validation-cache.js";
import { closeOpenClawAgentDatabasesAsync } from "../../state/openclaw-agent-db.js";
import {
  directSessionReq,
  setupGatewaySessionsHandlerTestHarness,
} from "../test/server-sessions.test-helpers.js";

const { createSessionStoreDir } = setupGatewaySessionsHandlerTestHarness();
afterEach(() => vi.restoreAllMocks());

test("sessions.create and patch survive a peer publishing the same cold admission", async () => {
  const { storePath } = await createSessionStoreDir();
  const key = "agent:main:dashboard:schema-publication";
  const capture = validationCache.captureOpenClawAgentDatabaseAdmissionPublication;
  let publications = 0;
  vi.spyOn(validationCache, "captureOpenClawAgentDatabaseAdmissionPublication").mockImplementation(
    (target) => {
      const publish = capture(target);
      const peer = capture(target);
      return (identity, received) => {
        // Deliver a concurrent opener's real checked facts before this request's reply.
        peer(identity, structuredClone(received));
        publications += 1;
        publish(identity, received);
      };
    },
  );
  for (const operation of ["create", "patch"] as const) {
    await closeOpenClawAgentDatabasesAsync();
    validationCache.clearOpenClawAgentDatabaseValidationCache(
      resolveSqliteTargetFromSessionStorePath(storePath, { agentId: "main" }).path,
    );
    publications = 0;
    const response = await directSessionReq(`sessions.${operation}`, {
      key,
      agentId: "main",
      label: `Published ${operation}`,
    });

    expect(response.ok, JSON.stringify(response.error)).toBe(true);
    expect(publications).toBeGreaterThan(0);
    expect(loadSessionEntry({ agentId: "main", sessionKey: key, storePath })).toMatchObject({
      label: `Published ${operation}`,
    });
  }
});
