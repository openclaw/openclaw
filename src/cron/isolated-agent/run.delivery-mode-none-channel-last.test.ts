import { describe, expect, it } from "vitest";
import {
  makeIsolatedAgentTurnJob,
  makeIsolatedAgentTurnParams,
  setupRunCronIsolatedAgentTurnSuite,
} from "./run.suite-helpers.js";
import {
  loadRunCronIsolatedAgentTurn,
  resolveCronDeliveryPlanMock,
  resolveDeliveryTargetMock,
  runEmbeddedPiAgentMock,
  runWithModelFallbackMock,
} from "./run.test-harness.js";

const runCronIsolatedAgentTurn = await loadRunCronIsolatedAgentTurn();

describe("runCronIsolatedAgentTurn — delivery.mode=none + channel:last (#30393)", () => {
  setupRunCronIsolatedAgentTurnSuite();

  it("skips delivery target resolution and keeps messageChannel unset", async () => {
    resolveCronDeliveryPlanMock.mockReturnValueOnce({
      mode: "none",
      channel: undefined,
      to: undefined,
      accountId: undefined,
      source: "delivery",
      requested: false,
    });

    runWithModelFallbackMock.mockImplementationOnce(
      async (params: {
        run: (providerOverride: string, modelOverride: string) => Promise<unknown>;
        provider: string;
        model: string;
      }) => ({
        result: await params.run(params.provider, params.model),
        provider: params.provider,
        model: params.model,
        attempts: [],
      }),
    );

    const result = await runCronIsolatedAgentTurn(
      makeIsolatedAgentTurnParams({
        job: makeIsolatedAgentTurnJob({
          delivery: { mode: "none", channel: "last" },
        }),
      }),
    );

    expect(result.status).toBe("ok");
    expect(resolveDeliveryTargetMock).not.toHaveBeenCalled();
    expect(runEmbeddedPiAgentMock).toHaveBeenCalledOnce();

    const embeddedArgs = runEmbeddedPiAgentMock.mock.calls[0]?.[0] as
      | { messageChannel?: string; disableMessageTool?: boolean }
      | undefined;
    expect(embeddedArgs?.messageChannel).toBeUndefined();
    expect(embeddedArgs?.disableMessageTool).toBe(true);
  });
});
