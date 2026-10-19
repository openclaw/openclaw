import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { makeCfg, withTempCronHome } from "../isolated-agent.test-harness.js";
import { dispatchCronDelivery } from "./delivery-dispatch.js";
import { makeResolvedDelivery } from "./delivery-dispatch.test-fixtures.js";
import { makeIsolatedAgentJobFixture, makeIsolatedAgentParamsFixture } from "./job-fixtures.js";
import { setupRunCronIsolatedAgentTurnSuite } from "./run.suite-helpers.js";
import {
  dispatchCronDeliveryMock,
  loadRunCronIsolatedAgentTurn,
  makeCronSession,
  mockRunCronFallbackPassthrough,
  resolveCronDeliveryPlanMock,
  resolveCronSessionMock,
  resolveDeliveryTargetMock,
  runEmbeddedAgentMock,
} from "./run.test-harness.js";

const { hasUnsettledCronDescendants, sendCronAnnouncePayloadStrict } = vi.hoisted(() => ({
  hasUnsettledCronDescendants: vi.fn(),
  sendCronAnnouncePayloadStrict: vi.fn(),
}));
vi.mock("./delivery-subagent-registry.runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./delivery-subagent-registry.runtime.js")>()),
  hasUnsettledCronDescendants,
}));
vi.mock("../delivery.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../delivery.js")>()),
  sendCronAnnouncePayloadStrict,
}));

vi.doUnmock("./helpers.js");
const runCronIsolatedAgentTurn = await loadRunCronIsolatedAgentTurn();
const { resolveCronDeliveryPlan } =
  await vi.importActual<typeof import("../delivery-plan.js")>("../delivery-plan.js");

describe("isolated hook delivery cancellation", () => {
  setupRunCronIsolatedAgentTurnSuite({ fast: true });

  it.each(["resolved", "rejected"])(
    "keeps a completed hook reader successful when delivery preparation is cancelled (%s)",
    async (settlement) => {
      await withTempCronHome(async (home) => {
        const storePath = path.join(home, "agents", "main", "sessions", "sessions.json");
        resolveCronSessionMock.mockReturnValue(makeCronSession({ storePath }));
        resolveDeliveryTargetMock.mockResolvedValue(makeResolvedDelivery());
        resolveCronDeliveryPlanMock.mockImplementation(resolveCronDeliveryPlan);
        dispatchCronDeliveryMock.mockImplementation(dispatchCronDelivery);
        mockRunCronFallbackPassthrough();
        const controller = new AbortController();
        const reason = new Error("Hook cancelled during delivery preparation");
        runEmbeddedAgentMock.mockResolvedValue({
          payloads: [{ text: "Mail reader finished." }],
          meta: { agentMeta: {} },
        });
        hasUnsettledCronDescendants.mockImplementationOnce(async () => {
          controller.abort(reason);
          if (settlement === "rejected") {
            throw reason;
          }
          return false;
        });
        const result = await runCronIsolatedAgentTurn(
          makeIsolatedAgentParamsFixture({
            cfg: makeCfg(home, storePath),
            agentId: "main",
            sessionKey: "hook:imap:inbox:1:1",
            abortSignal: controller.signal,
            job: makeIsolatedAgentJobFixture({
              delivery: { mode: "announce", channel: "telegram", to: "123456" },
            }),
          }),
        );

        expect(result.status).toBe("ok");
        expect(result.error).toBeUndefined();
        expect(result.delivered).toBe(false);
        expect(result.deliveryError).toBe(reason.message);
        expect(result.summary).toBe("Mail reader finished.");
        expect(runEmbeddedAgentMock).toHaveBeenCalledOnce();
        expect(sendCronAnnouncePayloadStrict).not.toHaveBeenCalled();
      });
    },
  );
});
