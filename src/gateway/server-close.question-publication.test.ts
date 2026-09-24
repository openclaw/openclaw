import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, vi } from "vitest";
import { createDeferredCore } from "../shared/deferred.js";
import {
  assertNoOpenClawAgentDatabaseLeasesReadOnly,
  OpenClawAgentDatabaseLeaseActiveError,
} from "../state/openclaw-agent-db-lease.js";
import { openOpenClawAgentDatabase } from "../state/openclaw-agent-db.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { createGatewayMetadataCloseFixture } from "./server-close.metadata.test-support.js";

it.each(["fulfilled", "rejected"] as const)(
  "joins %s question publication before closing Gateway databases and leases",
  async (outcome) => {
    const fixture = await createGatewayMetadataCloseFixture(`gateway-question-close-${outcome}`);
    const entered = createDeferredCore();
    const release = createDeferredCore();
    let closing: Promise<void> | undefined;
    let restoreDrain: (() => void) | undefined;
    try {
      const port = await fixture.reservePort();
      const server = await fixture.start(port);
      const manager = expectDefined(fixture.kernels.get(port)?.questionManager, "question owner");
      const agent = openOpenClawAgentDatabase({ agentId: "main", env: fixture.state.env });
      const shared = openOpenClawStateDatabase({ env: fixture.state.env }).db;
      const onResolved = vi.fn(async () => {
        await release.promise;
        if (outcome === "rejected") {
          throw new Error("Question publication fixture failure");
        }
      });
      const request = {
        questions: [
          {
            questionId: "choice",
            header: "Choice",
            question: "Choose a response",
            options: [],
            isOther: true,
          },
        ],
        timeoutMs: 60_000,
        onResolved,
      };
      const record = manager.request(request);
      const observation = expectDefined(manager.observe(record.id), "question observation");
      const answers = { answers: { choice: ["Committed"] } };
      expect(manager.resolve(record.id, answers)).toEqual({ status: "answered", answers });
      expect(onResolved).toHaveBeenCalledOnce();
      const drain = manager.drain.bind(manager);
      const observedDrain = vi.spyOn(manager, "drain").mockImplementation(() => {
        entered.resolve();
        return drain();
      });
      restoreDrain = () => observedDrain.mockRestore();
      let closed = false;
      closing = server
        .close({ reason: "gateway restarting", restartExpectedMs: 1_500 })
        .then(() => {
          closed = true;
        });
      await Promise.race([
        entered.promise,
        closing.then(() => {
          throw new Error("Gateway closed before joining question publication");
        }),
      ]);
      expect(observedDrain).toHaveBeenCalledOnce();
      expect(() => manager.request({ questions: record.questions, timeoutMs: 100 })).toThrow(
        "Question manager is closed",
      );
      expect(closed).toBe(false);
      expect(agent.db.isOpen).toBe(true);
      expect(shared.isOpen).toBe(true);
      expect(() => assertNoOpenClawAgentDatabaseLeasesReadOnly({ env: fixture.state.env })).toThrow(
        OpenClawAgentDatabaseLeaseActiveError,
      );
      release.resolve();
      await closing;
      expect(closed).toBe(true);
      expect(observation.record).toMatchObject({ status: "answered", answers });
      expect(agent.db.isOpen).toBe(false);
      expect(shared.isOpen).toBe(false);
      expect(() =>
        assertNoOpenClawAgentDatabaseLeasesReadOnly({ env: fixture.state.env }),
      ).not.toThrow();
    } finally {
      release.resolve();
      await Promise.allSettled([closing]);
      restoreDrain?.();
      await fixture.cleanup();
    }
  },
);
