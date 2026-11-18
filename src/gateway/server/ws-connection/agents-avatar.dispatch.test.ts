import { expect, it, vi } from "vitest";
import {
  createDispatchTestHarness,
  createOperatorWsClient,
} from "./authenticated-request-dispatch.test-support.js";

it("rejects avatar generation from a read-only WebSocket operator before invoking the method", async () => {
  const generation = vi.fn();
  const harness = createDispatchTestHarness({
    extraHandlers: { "agents.avatar.generate": generation },
  });
  const client = createOperatorWsClient({ scopes: ["operator.read"] });
  await harness.dispatcher.dispatch(
    {
      type: "req",
      id: "read-only-avatar",
      method: "agents.avatar.generate",
      params: { agentId: "main", prompt: "A gardener" },
    },
    client,
  );
  expect(await harness.awaitResponseFrame("read-only-avatar")).toMatchObject({
    ok: false,
    error: { code: "FORBIDDEN" },
  });
  expect(generation).not.toHaveBeenCalled();
});
