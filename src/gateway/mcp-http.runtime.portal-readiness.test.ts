import { expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../test/helpers/promise.js";
import {
  createAdmittedRunOperatorAuthority,
  createOperationalRunInstanceRef,
  prepareAgentRunAdmission,
} from "../agents/admitted-run-context.js";
import * as computerAvailability from "../agents/computer-use-node-capabilities.js";
import "../agents/test-helpers/fast-bash-tools.js";
import "../agents/test-helpers/fast-coding-tools.js";
import { prepareSessionPortalToolTarget } from "../agents/tools/session-portal-target.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.sqlite-entry.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { withPluginRuntimeGatewayContextResolver } from "../plugins/runtime/gateway-request-scope.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  McpLoopbackToolCache,
  resolveMcpLoopbackPolicyTools,
  resolveMcpLoopbackScopedTools,
} from "./mcp-http.runtime.js";
import type { GatewayRequestContext } from "./server-methods/types.js";
import { bindSessionRowProjection } from "./session-row-projection-access.js";
import { createSessionRowProjection } from "./session-row-projection.js";

it.for([
  { mode: "exact", boundary: "availability" },
  { mode: "policy", boundary: "availability" },
  { mode: "cached", boundary: "authority" },
  { mode: "exact", boundary: "final publication" },
  { mode: "policy", boundary: "final publication" },
  { mode: "cached", boundary: "final publication" },
  { mode: "cached", boundary: "readiness" },
] as const)(
  "revalidates portal catalog facts after $mode $boundary",
  async ({ mode, boundary }, { signal }) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const cfg: OpenClawConfig = { tools: { profile: "coding", deny: ["computer"] } };
      await state.writeConfig(cfg);
      setRuntimeConfigSnapshot(cfg);
      const identity = {
        sessionKey: "agent:main:portal-readiness",
        sessionId: "portal-readiness",
        agentId: "main",
      };
      const scope = { agentId: identity.agentId, sessionKey: identity.sessionKey };
      const entry = {
        sessionId: identity.sessionId,
        updatedAt: 1,
        modelSelectionLocked: boundary === "readiness",
      };
      replaceSessionEntrySync(scope, entry);
      const projection = await createSessionRowProjection({ cfg });
      const binding = { ...identity, environmentId: "attached", ownerEpoch: 1, generation: 1 };
      const context = bindSessionRowProjection(
        {
          getRuntimeConfig: () => cfg,
          portalService: {},
          workerEnvironmentService: {
            captureSessionAttachment: (requested: typeof identity) => {
              expect(requested).toMatchObject(identity);
              return { binding, assertCurrent: () => {}, touch: async () => {} };
            },
            getDedicatedNodeLeaseSignal: () => signal,
          },
          // SAFETY: Catalog discovery uses only these attachment and projection capabilities.
        } as unknown as GatewayRequestContext,
        () => projection,
      );
      const authorityAbort = new AbortController();
      const admission =
        boundary === "authority"
          ? prepareAgentRunAdmission({
              cfg,
              operationalRunInstance: createOperationalRunInstanceRef("portal-controller"),
              facts: {
                runId: "portal-controller",
                agentId: identity.agentId,
                ingress: { kind: "system", boundary: "portal-readiness", state: "present" },
              },
              operatorAuthority: createAdmittedRunOperatorAuthority({
                profileId: "portal-controller",
                scopes: ["operator.write"],
                signal: authorityAbort.signal,
                assertCurrent: () => {},
              }),
            })
          : undefined;
      const cache = new McpLoopbackToolCache();
      const releaseAvailability = createDeferred();
      let pending: Promise<unknown> | undefined;
      let restore: (() => void) | undefined;
      const onAbort = () => releaseAvailability.resolve();
      signal.addEventListener("abort", onAbort, { once: true });
      try {
        await projection.ensureMaterialized();
        await withPluginRuntimeGatewayContextResolver(
          () => context,
          async () => {
            const params: Parameters<McpLoopbackToolCache["resolve"]>[0] = {
              cfg,
              grantToken: "synthetic-portal-grant",
              isGrantCurrent: () => true,
              signal,
              admittedRunContext: await admission?.admit("gateway"),
              context: {
                ...identity,
                senderIsOwner: false,
                modelHasVision: true,
                toolsAllow:
                  boundary === "final publication" || boundary === "readiness"
                    ? ["portal"]
                    : ["portal", "computer"],
              },
            };
            const resolve =
              mode === "cached"
                ? cache.resolve.bind(cache)
                : mode === "exact"
                  ? resolveMcpLoopbackScopedTools
                  : resolveMcpLoopbackPolicyTools;
            const primed = await resolve(params);
            expect(primed.tools.map((tool) => tool.name)).toEqual(
              boundary === "readiness" ? [] : ["portal"],
            );
            const retained = prepareSessionPortalToolTarget(identity);
            if (boundary !== "readiness") {
              expect(retained).toBeDefined();
            }

            if (boundary === "final publication" || boundary === "readiness") {
              let published = false;
              const prepare = projection.withPreparedExactRows.bind(projection);
              const spy = vi
                .spyOn(projection, "withPreparedExactRows")
                .mockImplementation((queries, consume, options) =>
                  prepare(
                    queries,
                    (read) => {
                      const catalog = consume(read);
                      if (!published) {
                        published = true;
                        replaceSessionEntrySync(scope, {
                          ...entry,
                          updatedAt: 2,
                          modelSelectionLocked: boundary !== "readiness",
                        });
                      }
                      return catalog;
                    },
                    options,
                  ),
                );
              restore = () => spy.mockRestore();
              const resolving = resolve(params);
              pending = resolving;
              expect((await withinTest(resolving, signal)).tools.map((tool) => tool.name)).toEqual(
                boundary === "readiness" ? ["portal"] : [],
              );
              expect(published).toBe(true);
              if (retained) {
                expect(() => retained.assertCurrent()).toThrow();
              }
              return;
            }

            if (boundary === "authority") {
              const prepare = projection.withPreparedExactRows.bind(projection);
              const spy = vi
                .spyOn(projection, "withPreparedExactRows")
                .mockImplementation((queries, consume, options) =>
                  prepare(
                    queries,
                    (read) => {
                      const catalog = consume(read);
                      authorityAbort.abort(new Error("Synthetic controller retirement"));
                      return catalog;
                    },
                    options,
                  ),
                );
              restore = () => spy.mockRestore();
              pending = resolve(params);
              await expect(pending).rejects.toThrow(
                "admitted run operator authority is no longer active",
              );
              return;
            }

            const availabilityReturned = createDeferred();
            const load = computerAvailability.loadPairedComputerUseAvailabilityForSurface;
            const spy = vi
              .spyOn(computerAvailability, "loadPairedComputerUseAvailabilityForSurface")
              .mockImplementation(async (...args) => {
                const result = await load(...args);
                availabilityReturned.resolve();
                await releaseAvailability.promise;
                return result;
              });
            restore = () => spy.mockRestore();
            const resolving = resolve(params);
            pending = resolving;
            await withinTest(
              awaitGateBeforeSettlement(
                availabilityReturned.promise,
                resolving,
                "catalog resolved before the availability barrier",
              ),
              signal,
            );
            replaceSessionEntrySync(scope, { ...entry, updatedAt: 2, modelSelectionLocked: true });
            expect(() => retained?.assertCurrent()).toThrow();
            releaseAvailability.resolve();
            expect((await withinTest(resolving, signal)).tools.map((tool) => tool.name)).toEqual(
              [],
            );
          },
        );
      } finally {
        releaseAvailability.resolve();
        await pending?.catch(() => {});
        restore?.();
        signal.removeEventListener("abort", onAbort);
        cache.clear();
        admission?.close();
        projection.dispose();
      }
    });
  },
);
