import { afterEach, describe, expect, it, vi } from "vitest";
import {
  closeVisitorFixtures,
  NOW,
  visitorFixture,
  visitorGrant,
} from "../extensions/visitor-access/test-api.js";
import { createFixture } from "../src/gateway/control-ui-session-pr-access.test-support.js";
import { createRequestGatewayMethodRegistry } from "../src/gateway/server-methods.js";
import { createPluginStateKeyedStore } from "../src/plugin-state/plugin-state-store.js";
import { createPluginRegistry } from "../src/plugins/registry.js";
import { withPluginRuntimeGatewayRequestScope } from "../src/plugins/runtime/gateway-request-scope.js";
import { createPluginRuntime } from "../src/plugins/runtime/index.js";
import { createPluginRecord } from "../src/plugins/status.test-helpers.js";
import { closeOpenClawStateDatabaseForTest } from "../src/state/openclaw-state-db.js";
import { linkEmail } from "../src/state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../src/state/user-profiles.js";
import { withOpenClawTestState } from "../src/test-utils/openclaw-test-state.js";

afterEach(() => {
  closeVisitorFixtures();
  vi.restoreAllMocks();
  closeOpenClawStateDatabaseForTest();
});

describe("Visitor revocation identity", () => {
  it.each(["grant commit", "provider dispatch"] as const)(
    "refuses a same-email reassignment before %s",
    async (boundary) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        vi.spyOn(Date, "now").mockReturnValue(NOW);
        const gateway = await createFixture("operator.read");
        const registry = createRequestGatewayMethodRegistry();
        gateway.context.getGatewayMethodRegistry = () => registry;
        const runtime = createPluginRuntime();
        const plugins = createPluginRegistry({
          runtime,
          logger: { info() {}, warn() {}, error() {}, debug() {} },
          activateGlobalSideEffects: false,
        });
        const record = createPluginRecord({ id: "visitor-access", origin: "bundled" });
        const api = plugins.createApi(record, { config: gateway.cfg });
        plugins.registry.plugins.push(record);
        const run = <T>(execute: () => Promise<T>) =>
          withPluginRuntimeGatewayRequestScope(
            {
              context: gateway.context,
              client: gateway.client,
              isWebchatConnect: () => false,
              pluginId: "visitor-access",
              pluginOrigin: "bundled",
            },
            execute,
          );
        try {
          const grant = visitorGrant("moving@example.test");
          const options = { env: state.env };
          const original = ensureProfileForEmail(grant.email, options);
          linkEmail("retained@example.test", original.id, options);
          const replacement = ensureProfileForEmail("replacement@example.test", options);
          const store = createPluginStateKeyedStore<typeof grant>("visitor-access", {
            namespace: "visitor-grants",
            maxEntries: 50,
            env: state.env,
          });
          await store.register(grant.email, grant);
          const withCurrent = store.withCurrent;
          if (!withCurrent) {
            throw new Error("Expected the native action-bound store");
          }
          let reassign = true;
          const visitor = visitorFixture({
            emails: [grant.email],
            gateway: api.runtime.gateway,
            store: {
              ...store,
              withCurrent(authority) {
                const guarded = withCurrent(authority);
                return {
                  ...guarded,
                  register(key, value, entryOptions) {
                    const pending = guarded.register(key, value, entryOptions);
                    if (
                      boundary === "grant commit" &&
                      reassign &&
                      key === grant.email &&
                      value.expiresAt === NOW
                    ) {
                      reassign = false;
                      linkEmail(grant.email, replacement.id, options);
                    }
                    return pending;
                  },
                };
              },
            },
          });
          await visitor.service.initialize();
          if (boundary === "provider dispatch") {
            const update = visitor.policy.update.bind(visitor.policy);
            vi.spyOn(visitor.policy, "update").mockImplementation((change, assertCurrent) =>
              update(async (emails) => {
                const selected = await change(emails);
                if (reassign) {
                  reassign = false;
                  linkEmail(grant.email, replacement.id, options);
                }
                return selected;
              }, assertCurrent),
            );
          }
          await expect(
            run(() =>
              visitor.service.revoke({ profileId: original.id }, visitor.authority.assertCurrent),
            ),
          ).rejects.toThrow();
          expect(reassign).toBe(false);
          expect(await store.lookup(grant.email)).toEqual(
            boundary === "grant commit" ? grant : { ...grant, expiresAt: NOW },
          );
          expect(visitor.mutations()).toEqual([]);
          if (boundary === "grant commit") {
            expect(() => visitor.service.authorize([grant.email]).assertCurrent()).not.toThrow();
          }
          await expect(
            run(() =>
              visitor.service.revoke(
                { profileId: replacement.id },
                visitor.authority.assertCurrent,
              ),
            ),
          ).resolves.toMatchObject({ details: { outcome: "revoked", emails: [grant.email] } });
          expect(await store.lookup(grant.email)).toBeUndefined();
          expect(visitor.emails()).toEqual([]);
        } finally {
          plugins.rollbackPluginGlobalSideEffects(record.id, record);
          await gateway.close();
          await gateway.removeSessions();
        }
      });
    },
  );
});
