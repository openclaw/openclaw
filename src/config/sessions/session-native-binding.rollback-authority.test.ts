import assert from "node:assert/strict";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, expect, it, vi } from "vitest";
import * as admission from "../../infra/sqlite-worker-operation-admission.js";
import { createSessionInitialization } from "../../sessions/session-initialization.js";
import { withNativeBindingFixture } from "./session-native-binding.test-support.js";

afterEach(() => vi.restoreAllMocks());

it.each([false, true])(
  "retains rollback authority without a same-database grant reread (binding: %s)",
  async (withBinding) => {
    await withNativeBindingFixture("agentsapi", async (fixture) => {
      if (!withBinding) {
        fixture.registry.agentHarnesses.length = 0;
      }
      const entry = fixture.readEntry();
      assert(entry);
      let grantDatabasePath: string | undefined;
      let agentGrants = 0;
      let authorityReads = 0;
      let otherOwnerAuthorityReads = 0;
      let revoked = true;
      const refusal = new Error("synthetic rollback authority revoked");
      const create = admission.createSqliteWorkerOperationAdmission;
      vi.spyOn(admission, "createSqliteWorkerOperationAdmission").mockImplementation(
        (callback, attachment) => {
          let databasePath: string | undefined;
          const owned = create((request, grant) => {
            const previous = grantDatabasePath;
            const identity = isRecord(request.facts) ? request.facts.identity : undefined;
            grantDatabasePath =
              isRecord(identity) && typeof identity.nativeLocation === "string"
                ? identity.nativeLocation
                : databasePath;
            if (grantDatabasePath === fixture.database.path) {
              agentGrants++;
            }
            try {
              callback(request, grant);
            } finally {
              grantDatabasePath = previous;
            }
          }, attachment);
          const bind = owned.bindDatabaseAuthority.bind(owned);
          owned.bindDatabaseAuthority = (authority) => {
            databasePath = authority.databasePath;
            bind(authority);
          };
          return owned;
        },
      );
      const initializer = createSessionInitialization(
        { ...fixture.scope, lifecycleRevision: entry.lifecycleRevision },
        () => {
          expect(grantDatabasePath).not.toBe(fixture.database.path);
          fixture.readEntry();
          authorityReads++;
          if (grantDatabasePath === fixture.shared.path) {
            otherOwnerAuthorityReads++;
          }
          if (revoked) {
            throw refusal;
          }
        },
        { config: {}, agentId: fixture.scope.agentId, entry },
      );
      try {
        await expect(initializer.rollback(() => fixture.remove())).rejects.toBe(refusal);
        expect(fixture.readEntry()).toEqual(entry);
        expect(fixture.readBinding()).toBeDefined();
        revoked = false;
        await expect(initializer.rollback(() => fixture.remove())).resolves.toMatchObject({
          deleted: true,
        });
        expect(authorityReads).toBeGreaterThan(0);
        expect(agentGrants).toBeGreaterThan(0);
        expect(fixture.readEntry()).toBeUndefined();
        expect(() => initializer.handle.assertCurrent()).toThrow(
          "Session initialization is rolling back",
        );
        if (withBinding) {
          expect(fixture.readBinding()).toBeUndefined();
          expect(otherOwnerAuthorityReads).toBeGreaterThan(0);
        } else {
          expect(fixture.readBinding()).toBeDefined();
        }
      } finally {
        initializer.close();
      }
    });
  },
);
