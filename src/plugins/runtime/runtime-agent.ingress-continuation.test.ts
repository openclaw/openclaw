import assert from "node:assert/strict";
import { setImmediate as nextTurn } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { enqueueCommandInLane } from "../../process/command-queue.js";
import {
  getActiveGatewayRootWorkCount,
  tryBeginGatewayRootWorkAdmission,
} from "../../process/gateway-work-admission.js";
import { AsyncWorkScope } from "../../shared/async-work-scope.js";
import { createRuntimeEnv } from "../../test-utils/plugin-runtime-env.js";
import { withPluginRuntimePluginScope } from "./gateway-request-scope.js";
import { createRuntimeAgent } from "./runtime-agent.js";

const agentCommandFromGatewayIngress = vi.hoisted(() => vi.fn());
vi.mock("../../agents/agent-command.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../agents/agent-command.js")>()),
  agentCommandFromGatewayIngress,
}));

describe("plugin runtime ingress admission", () => {
  it("runs a bridge consult that arrives after its starting request ended", async () => {
    agentCommandFromGatewayIngress.mockImplementationOnce(() =>
      enqueueCommandInLane("session:meeting-consult", async () => ({
        payloads: [{ text: "391" }],
      })),
    );
    const parent = tryBeginGatewayRootWorkAdmission("googlemeet.join");
    assert(parent);
    const work = new AsyncWorkScope();
    const toolCall = createDeferred();
    // A realtime bridge opened by the request delivers its tool call after the request returned.
    const consult = parent.run(() =>
      work.run(() =>
        withPluginRuntimePluginScope({ pluginId: "google-meet" }, async () => {
          await toolCall.promise;
          return createRuntimeAgent().runCommandFromIngress(
            {
              agentId: "main",
              sessionKey: "agent:main:subagent:google-meet:m1",
              message: "q",
              allowModelOverride: false,
            },
            createRuntimeEnv(),
          );
        }),
      ),
    );
    parent.release();
    await work.drain();
    toolCall.resolve();
    await expect(consult).resolves.toEqual({ payloads: [{ text: "391" }] });
    await nextTurn();
    expect(getActiveGatewayRootWorkCount()).toBe(0);
  });
});
