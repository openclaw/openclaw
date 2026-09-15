import { describe, expect, it } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { createDraftFixture } from "./draft-submission-flow.test-support.ts";

describe("draft catalog refresh ownership", () => {
  it.each(["client", "gateway", "principal", "owner"] as const)(
    "retains cached Cloud choices only for the same owner across a %s change",
    async (change) => {
      const retained = [{ id: "retained", providerId: "test" }];
      const late = createDeferred<{ environments: []; profiles: typeof retained }>();
      let pending = false;
      const fixture = createDraftFixture({
        methods: ["environments.list"],
        scopes: ["operator.admin", "operator.read", "operator.write"],
        request: async () => (pending ? late.promise : { environments: [], profiles: retained }),
      });
      try {
        await fixture.gateway.refreshCloudProfiles();
        expect(fixture.gateway.cloudProfiles).toEqual(retained);
        pending = true;
        void fixture.gateway.refreshCloudProfiles();
        const gateway = fixture.context.gateway;
        if (change === "gateway") {
          gateway.connection.gatewayUrl = "ws://other.example";
        }
        if (change === "principal") {
          gateway.snapshot.hello!.auth!.recoveryScope = "other-principal";
        }
        if (change === "client") {
          gateway.snapshot.client = createTestGatewayClient(fixture.request);
        }
        fixture.gateway.synchronize(change === "owner" ? { ...gateway } : gateway);
        const expected = change === "client" ? retained : [];
        expect(fixture.gateway.cloudProfiles).toEqual(expected);
        late.resolve({
          environments: [],
          profiles: [{ id: "obsolete-response", providerId: "test" }],
        });
        await late.promise;
        await Promise.resolve();
        await Promise.resolve();
        expect(fixture.gateway.cloudProfiles).toEqual(expected);
        expect(fixture.gateway.cloudProfilesPending).toBe(false);
      } finally {
        late.resolve({ environments: [], profiles: [] });
        fixture.gateway.disconnect();
      }
    },
  );

  it.each(["inventory", "cloud"] as const)(
    "coalesces %s and retires its queued refresh on disconnect",
    async (kind) => {
      const first = createDeferred<{
        environments: [];
        profiles: Array<{ id: string; providerId: string }>;
      }>();
      const trailing = createDeferred<{
        environments: [];
        profiles: Array<{ id: string; providerId: string }>;
      }>();
      let count = 0;
      const fixture = createDraftFixture({
        methods: ["environments.list"],
        scopes: ["operator.admin", "operator.read", "operator.write"],
        request: async (method) => {
          if (method !== "environments.list") {
            return {};
          }
          count += 1;
          return count === 1 ? first.promise : trailing.promise;
        },
      });
      const refresh = () =>
        kind === "inventory"
          ? fixture.gateway.refreshEnvironments()
          : fixture.gateway.refreshCloudProfiles();
      try {
        const active = refresh();
        const queued = Array.from({ length: 32 }, refresh);
        expect(count).toBe(1);
        first.resolve({ environments: [], profiles: [{ id: "retained", providerId: "test" }] });
        await active;
        await Promise.resolve();
        expect(count).toBe(2);
        // Lit retires taskComplete without settling it on initialState; callers fire-and-forget.
        for (let index = 0; index < 8; index += 1) {
          void refresh();
        }
        fixture.gateway.disconnect();
        trailing.resolve({ environments: [], profiles: [{ id: "retired", providerId: "test" }] });
        await Promise.all(queued);
        await Promise.resolve();
        expect(count).toBe(2);
        expect(fixture.gateway.connected).toBe(false);
        expect(fixture.gateway.cloudProfiles).toEqual(
          kind === "cloud" ? [{ id: "retained", providerId: "test" }] : [],
        );
        expect(fixture.gateway.cloudProfilesPending).toBe(false);
        expect(fixture.gateway.deviceCatalogDisabledReason).toBeDefined();
      } finally {
        first.resolve({ environments: [], profiles: [] });
        trailing.resolve({ environments: [], profiles: [] });
        fixture.gateway.disconnect();
      }
    },
  );
});
