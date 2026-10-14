import { describe, expect, it, vi } from "vitest";
import type { GatewayProtocolRequestOptions } from "../../../../packages/gateway-client/src/protocol-request.js";
import type { GatewayBrowserClient, GatewayEventListener } from "../../api/gateway.ts";
import type { PluginMutationResult } from "./index.ts";
import { installPlugin } from "./install.ts";

describe("plugin install progress correlation", () => {
  it("isolates concurrent requests and retires listeners at each final response", async () => {
    const listeners = new Set<GatewayEventListener>();
    const pending: Array<{
      resolve: (result: PluginMutationResult) => void;
      reject: (error: Error) => void;
    }> = [];
    const client = {
      addEventListener: (listener: GatewayEventListener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      request: (_method: string, _params: unknown, options?: GatewayProtocolRequestOptions) => {
        options?.onSent?.(`request-${pending.length}`);
        return new Promise<PluginMutationResult>((resolve, reject) => {
          pending.push({ resolve, reject });
        });
      },
    } as unknown as GatewayBrowserClient;
    const first = vi.fn();
    const second = vi.fn();
    const one = installPlugin(client, { source: "npm", spec: "one" }, first);
    const two = installPlugin(client, { source: "npm", spec: "two" }, second);
    const emit = (requestId: string, status = "started") => {
      for (const listener of listeners) {
        listener({
          type: "event",
          event: "plugins.install.progress",
          payload: { requestId, activityId: "activity", stage: "dependencies", status },
        });
      }
    };
    emit("request-1");
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
    emit("request-0");
    emit("request-0", "invented");
    expect(first).toHaveBeenCalledTimes(1);
    const result = { ok: true } as PluginMutationResult;
    pending[0]!.resolve(result);
    await expect(one).resolves.toBe(result);
    emit("request-0", "completed");
    expect(first).toHaveBeenCalledTimes(1);
    expect(listeners.size).toBe(1);
    const failure = new Error("registry unavailable");
    pending[1]!.reject(failure);
    await expect(two).rejects.toBe(failure);
    expect(listeners.size).toBe(0);
  });
});
