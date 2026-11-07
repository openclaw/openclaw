import { describe, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement } from "../../../test/helpers/promise.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import { createDeferredCore } from "../../shared/deferred.js";
import * as sessionCreation from "../session-create-service.js";
import { withConfidentialPi } from "./session-catalog-native-confidential.test-support.js";

describe("native catalog import source lease", () => {
  it.each([
    ["legacy", "bob", true],
    ["private", "alice", true],
    ["private", "admin", true],
    ["audience", "bob", true],
    ["source", "bob", true],
    ["private", "bob", false],
    ["audience", "eve", false],
  ] as const)("keeps actual adopted import access for %s / %s / %s", async (thread, who, allowed) =>
    withConfidentialPi(async (fixture) => {
      const target = await fixture.prepareImport(thread, fixture.clients[who]);
      const result = await target.run();
      expect(result.ok).toBe(allowed);
      if (allowed) {
        expect(result).toMatchObject({ payload: { importedItems: 1 } });
        expect(JSON.stringify(await target.transcript())).toContain("PRIVATE_NATIVE_" + thread);
      } else {
        expect(result).toMatchObject({ ok: false, payload: undefined });
        expect(target.entry()).toBeUndefined();
        expect(await target.transcript()).toEqual([]);
      }
    }),
  );

  it("imports and replays an unbound real Pi transcript across own effects", () =>
    withConfidentialPi(async (fixture) => {
      const target = await fixture.prepareImport();
      const first = await target.run();
      expect(first).toMatchObject({ ok: true, payload: { created: true, importedItems: 5 } });
      const before = await target.transcript();
      expect(before).toHaveLength(6);
      expect(JSON.stringify(before)).toContain("PRIVATE_NATIVE_unbound");
      expect(await target.run()).toMatchObject({
        ok: true,
        payload: { created: false, importedItems: 0 },
      });
      expect(await target.transcript()).toEqual(before);
    }, true));

  it.each(["different-key adoption", "same-key takeover", "unrelated row"] as const)(
    "checks real native source custody across %s while destination awaits",
    async (change) =>
      withConfidentialPi(async (fixture) => {
        const target = await fixture.prepareImport();
        const create = sessionCreation.createGatewaySession;
        const entered = createDeferredCore(),
          release = createDeferredCore();
        using _ = vi
          .spyOn(sessionCreation, "createGatewaySession")
          .mockImplementationOnce(async (params) => {
            entered.resolve();
            await release.promise;
            return create(params);
          });
        const running = target.run();
        try {
          await awaitGateBeforeSettlement(
            entered.promise,
            running,
            "real native import destination",
          );
          const key =
            change === "same-key takeover"
              ? target.key
              : "agent:main:plugin:acpx:catalog-adopt:pi:late";
          await upsertSessionEntryCore(
            { agentId: "main", sessionKey: key },
            {
              sessionId: "other-committed-session",
              lifecycleRevision: "other-lifecycle",
              updatedAt: 2,
              createdVia: "operator",
              createdActor: {
                type: "human",
                source: "profile",
                id: "00000000-0000-4000-8000-000000000001",
              },
              visibility: "shared",
              access: { mode: "creator" },
              ...(change === "same-key takeover"
                ? {}
                : {
                    pluginOwnerId: "acpx",
                    pluginExtensions: {
                      acpx: {
                        piSessionCatalog: {
                          sourceThreadId:
                            change === "unrelated row" ? "unrelated-thread" : "pi-session",
                        },
                      },
                    },
                  }),
            },
          );
          await fixture.projection.ensureMaterialized();
          await fixture.projection.prepareMembership();
        } finally {
          release.resolve();
        }
        const result = await running;
        if (change === "unrelated row") {
          expect(result).toMatchObject({ ok: true, payload: { importedItems: 5 } });
          expect(JSON.stringify(await target.transcript())).toContain("PRIVATE_NATIVE_unbound");
        } else {
          expect(result).toMatchObject({ ok: false, payload: undefined });
          expect(await target.transcript()).toEqual([]);
          if (change === "different-key adoption") {
            expect(target.entry()).toBeUndefined();
          } else {
            expect(target.entry()).toMatchObject({
              sessionId: "other-committed-session",
              access: { mode: "creator" },
            });
          }
        }
      }, true),
  );

  it.each(["source", "audience", "role", "agent"] as const)(
    "rejects live %s revocation during actual Pi import read",
    async (change) =>
      withConfidentialPi(async (fixture) => {
        const thread = change === "source" ? "source" : "audience";
        const target = await fixture.prepareImport(thread);
        const read = fixture.provider.read;
        const entered = createDeferredCore(),
          release = createDeferredCore();
        let heldPrivateBytes = false;
        using _ = vi.spyOn(fixture.provider, "read").mockImplementationOnce(async (request) => {
          const page = await read(request);
          heldPrivateBytes = JSON.stringify(page).includes("PRIVATE_NATIVE_" + thread);
          entered.resolve();
          await release.promise;
          return page;
        });
        const running = target.run();
        try {
          await awaitGateBeforeSettlement(entered.promise, running, "actual native provider read");
          if (change === "role") {
            fixture.cfg.gateway!.roles!.definitions!.reader!.sessions.others = "none";
          } else if (change === "agent") {
            fixture.cfg.gateway!.roles!.definitions!.reader!.agents = [];
          } else if (change === "source") {
            fixture.cfg.session!.sharing!.accessPolicy!.groups![0]!.profileIds = [];
          } else {
            await fixture.mutateAccess({ mode: "creator" });
          }
          setRuntimeConfigSnapshot(fixture.cfg);
        } finally {
          release.resolve();
        }
        expect(heldPrivateBytes).toBe(true);
        expect(await running).toMatchObject({ ok: false, payload: undefined });
        expect(target.entry()).toBeUndefined();
        expect(await target.transcript()).toEqual([]);
      }),
  );
});
