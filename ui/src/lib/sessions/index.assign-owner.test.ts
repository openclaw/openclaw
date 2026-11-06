import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import {
  createGatewayHarness,
  createTestSessionCapability,
} from "./session-capability.test-support.ts";

it.each([false, true])(
  "preserves owner assignment failure for its request (retired=%s)",
  async (retired) => {
    const request = createDeferred<unknown>();
    const error = new Error("Synthetic owner assignment rejected");
    const gateway = createGatewayHarness(createTestGatewayClient(vi.fn(() => request.promise)));
    const sessions = createTestSessionCapability(gateway.gateway);
    const completion = sessions.assignOwner("agent:main:owner", {
      type: "human",
      id: "person-one",
    });
    if (retired) {
      gateway.publish(false);
    }
    request.reject(error);
    if (retired) {
      await expect(completion).resolves.toBeNull();
    } else {
      await expect(completion).rejects.toBe(error);
    }
    expect(sessions.state.error).toBe(retired ? null : error.message);
    sessions.dispose();
  },
);
