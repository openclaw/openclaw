import { afterEach, expect, it, vi } from "vitest";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.js";
import { withPluginRuntimeGatewayContextResolver } from "../plugins/runtime/gateway-request-scope.js";
import { emitSessionIdentityMutation } from "../sessions/session-lifecycle-events.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import {
  closeOpenClawAgentDatabaseByPath,
  resolveIncognitoOpenClawAgentSqlitePath,
} from "../state/openclaw-agent-db.js";
import { observeMainThreadSql } from "../test-utils/main-thread-sql-spies.test-support.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { requestContext } from "./server-methods/sessions-read-cache.test-support.js";
import { captureGatewaySessionLifetime } from "./session-resource-lifetime.js";
import { bindSessionRowProjection } from "./session-row-projection-access.js";
import { createSessionRowProjection, type SessionRowProjection } from "./session-row-projection.js";

afterEach(() => vi.restoreAllMocks());

it("keeps resource identity across progress and fences reset, incognito retirement, and owner replacement", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const cfg = { agents: { entries: { main: { default: true } } } };
    const key = "agent:main:resource";
    const privateKey = "agent:main:dashboard:incognito-resource";
    const target = { agentId: "main", sessionKey: key };
    const entry = { sessionId: "resource-session", updatedAt: 1, lifecycleRevision: "initial" };
    replaceSessionEntrySync(target, entry);
    replaceSessionEntrySync(
      { agentId: "main", sessionKey: privateKey },
      {
        sessionId: "private-session",
        updatedAt: 1,
        incognito: true,
      },
    );
    const projection = await createSessionRowProjection({ cfg, modelCatalog: [] });
    let current: SessionRowProjection | undefined = projection;
    const context = bindSessionRowProjection(requestContext(cfg), () => current);
    const releases: Array<() => void> = [];
    try {
      await withPluginRuntimeGatewayContextResolver(
        () => context,
        async () => {
          const resource = await captureGatewaySessionLifetime(key);
          const privateResource = await captureGatewaySessionLifetime(privateKey);
          const operation = resource.retain();
          const privateOperation = privateResource.retain();
          releases.push(operation.release, privateOperation.release);
          emitSessionIdentityMutation({
            kind: "reset",
            agentId: "main",
            databaseIdentity: "another-physical-store",
            previous: { sessionKeys: [key], sessionId: entry.sessionId },
            current: { sessionKeys: [key], sessionId: "foreign-successor" },
          });
          expect(operation.signal.aborted).toBe(false);
          resource.assertCurrent();
          await projection.ensureMaterialized();
          expect(resource.target).toEqual({
            agentId: "main",
            sessionKey: key,
            sessionId: entry.sessionId,
            lifecycleRevision: "initial",
          });
          const sql = observeMainThreadSql();
          resource.assertCurrent();
          resource.assertCurrent();
          sql.expectIdle();
          sql.restore();
          const pending = vi
            .spyOn(projection, "sharingTargetState")
            .mockReturnValueOnce({ status: "pending" });
          expect(() => resource.assertCurrent()).toThrow("refreshing");
          pending.mockRestore();
          expect(() => resource.assertCurrent()).not.toThrow();
          replaceSessionEntrySync(target, { ...entry, updatedAt: 2, label: "Progress" });
          await projection.ensureMaterialized();
          expect(() => resource.assertCurrent()).not.toThrow();
          expect(operation.signal.aborted).toBe(false);
          replaceSessionEntrySync(target, { ...entry, lifecycleRevision: "reset" });
          expect(operation.signal.aborted).toBe(true);
          await projection.ensureMaterialized();
          expect(() => resource.assertCurrent()).toThrow("retired session lifetime");
          const successor = await captureGatewaySessionLifetime(key);
          expect(successor.target.lifecycleRevision).toBe("reset");
          const completed = successor.retain();
          completed.release();
          completed.release();
          expect(completed.signal.aborted).toBe(true);
          expect(() => completed.assertCurrent()).toThrow("borrow released");
          successor.assertCurrent();
          closeOpenClawAgentDatabaseByPath(
            resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main" }),
          );
          sessionChanges.emit({ all: true, scope: "stores" });
          expect(privateOperation.signal.aborted).toBe(true);
          expect(() => privateResource.assertCurrent()).toThrow("retired session lifetime");
          current = undefined;
          expect(() => successor.assertCurrent()).toThrow("retired session lifetime");
          current = projection;
          expect(() => successor.assertCurrent()).toThrow("retired session lifetime");
          await expect(captureGatewaySessionLifetime("agent:main:missing")).rejects.toThrow(
            "existing session",
          );
        },
      );
    } finally {
      for (const release of releases) {
        release();
      }
      projection.dispose();
    }
  });
});
