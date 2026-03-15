import { afterEach, describe, expect, it, vi } from "vitest";
import {
  _resetLocalGatewayDispatch,
  registerLocalGatewayDispatch,
  tryLocalGatewayDispatch,
} from "./local-dispatch.js";

describe("local-dispatch", () => {
  afterEach(() => {
    _resetLocalGatewayDispatch();
  });

  it("returns undefined when no dispatcher is registered", () => {
    const result = tryLocalGatewayDispatch("cron.list", {});
    expect(result).toBeUndefined();
  });

  it("dispatches locally after registration", async () => {
    const dispatcher = vi.fn().mockResolvedValue({ jobs: [] });
    registerLocalGatewayDispatch(dispatcher);

    const result = tryLocalGatewayDispatch("cron.list", { filter: "active" });
    expect(result).toBeInstanceOf(Promise);
    await expect(result).resolves.toEqual({ jobs: [] });
    expect(dispatcher).toHaveBeenCalledWith("cron.list", { filter: "active" });
  });

  it("returns undefined after reset", async () => {
    const dispatcher = vi.fn().mockResolvedValue({});
    registerLocalGatewayDispatch(dispatcher);

    expect(tryLocalGatewayDispatch("health", {})).toBeInstanceOf(Promise);
    _resetLocalGatewayDispatch();
    expect(tryLocalGatewayDispatch("health", {})).toBeUndefined();
  });

  it("propagates errors from the dispatcher", async () => {
    const dispatcher = vi.fn().mockRejectedValue(new Error("method failed"));
    registerLocalGatewayDispatch(dispatcher);

    const result = tryLocalGatewayDispatch("cron.add", {});
    await expect(result).rejects.toThrow("method failed");
  });
});
