import "./session-accessor.sqlite-replacement-publication.test-support.js";
import { expect, it } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../../test/helpers/promise.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { runOpenClawAgentWriteAdmission } from "../../state/openclaw-agent-write-admission.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { replaceSessionEntrySync } from "./session-accessor.sqlite-entry.js";
import { applySessionEntryExactReplacements } from "./session-accessor.sqlite-replacement-projection.js";
import { prepareSessionGenerationFacts } from "./session-delivery-generation.js";

const { getReplacementPublicationDelivery } =
  await import("./session-accessor.sqlite-replacement-publication.test-support.js");
const delivery = getReplacementPublicationDelivery();

it.for(["metadata", "replacement"] as const)(
  "joins admitted %s publication before checking the retained session generation",
  async (kind, { signal }) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const database = openOpenClawAgentDatabase({ agentId: "main" });
      const scope = {
        agentId: "main",
        storePath: database.path,
        sessionKey: "agent:main:generation-readiness",
      };
      const original = {
        sessionId: "generation-readiness",
        lifecycleRevision: "original-lifecycle",
        updatedAt: 1,
      };
      replaceSessionEntrySync(scope, original);
      const generation = await prepareSessionGenerationFacts({ ...scope, ...original });
      const releasedGeneration = await prepareSessionGenerationFacts({ ...scope, ...original });
      const writes: Promise<unknown>[] = [];
      const readiness: Promise<unknown>[] = [];
      let releaseReply = () => {};
      const onAbort = () => releaseReply();
      signal.addEventListener("abort", onAbort, { once: true });
      const replace = (label: string) =>
        applySessionEntryExactReplacements({
          ...scope,
          sessionKeys: [scope.sessionKey],
          requireWriteSuccess: true,
          update: () => ({
            result: undefined,
            replacements: [
              {
                sessionKey: scope.sessionKey,
                entry: {
                  ...original,
                  label,
                  lifecycleRevision:
                    kind === "replacement" ? "replacement-lifecycle" : original.lifecycleRevision,
                },
              },
            ],
          }),
        });
      try {
        for (const round of kind === "metadata" ? [0, 1] : [0]) {
          const committed = createDeferred();
          const release = createDeferred();
          releaseReply = () => release.resolve();
          delivery.afterResult = async () => {
            committed.resolve();
            await release.promise;
          };
          const write = replace(`metadata-${round}`);
          writes.push(write);
          await withinTest(
            awaitGateBeforeSettlement(
              committed.promise,
              write,
              "replacement did not reach publication",
            ),
            signal,
          );
          expect(generation.assertCurrent).toThrow(
            expect.objectContaining({ code: "SESSION_DELIVERY_GENERATION_UNAVAILABLE" }),
          );
          const pending = generation.prepareRead();
          expect(pending).toBeInstanceOf(Promise);
          if (!pending) {
            throw new Error("The admitted replacement must expose publication completion");
          }
          readiness.push(pending);
          let prepared = false;
          void pending.then(
            () => {
              prepared = true;
            },
            () => {},
          );
          let releasedRead: Promise<unknown> | undefined;
          if (round === 0) {
            releasedRead = releasedGeneration.prepareRead()?.catch((error: unknown) => error);
            expect(releasedRead).toBeInstanceOf(Promise);
            if (releasedRead) {
              readiness.push(releasedRead);
            }
            releasedGeneration.release();
          }
          await Promise.resolve();
          expect(prepared).toBe(false);
          release.resolve();
          await withinTest(write, signal);
          await withinTest(pending, signal);
          if (releasedRead) {
            await expect(releasedRead).resolves.toMatchObject({
              code: "SESSION_DELIVERY_GENERATION_UNAVAILABLE",
            });
          }
          expect(generation.prepareRead()).toBeUndefined();
          if (kind === "replacement") {
            expect(generation.assertCurrent).toThrow(
              expect.objectContaining({ code: "SESSION_DELIVERY_GENERATION_REVOKED" }),
            );
          } else {
            generation.assertCurrent();
          }
        }
        delivery.afterResult = undefined;
        if (kind === "metadata") {
          // A queued successor has not published an admission and cannot make its owner wait.
          let successor: Promise<unknown> | undefined;
          await runOpenClawAgentWriteAdmission(
            { agentId: scope.agentId, path: scope.storePath },
            () => {
              successor = replace("queued-successor");
              writes.push(successor);
              expect(generation.prepareRead()).toBeUndefined();
              generation.assertCurrent();
            },
          );
          if (!successor) {
            throw new Error("The admitted owner must start its queued successor");
          }
          await withinTest(successor, signal);
          generation.assertCurrent();
        }
      } finally {
        releaseReply();
        delivery.afterResult = undefined;
        await Promise.allSettled([...writes, ...readiness]);
        signal.removeEventListener("abort", onAbort);
        releasedGeneration.release();
        generation.release();
      }
    });
  },
);
