import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferredCore } from "../../shared/deferred.js";
import { installGatewayHostLifeline } from "./host-lifeline.js";

const originalStdin = Object.getOwnPropertyDescriptor(process, "stdin");

afterEach(() => {
  vi.restoreAllMocks();
  if (originalStdin) {
    Object.defineProperty(process, "stdin", originalStdin);
  }
  vi.unstubAllEnvs();
});

describe("Gateway host lifeline", () => {
  it.each([undefined, "unsupported"])("leaves stdin untouched for %s", (value) => {
    vi.stubEnv("OPENCLAW_GATEWAY_HOST_LIFELINE", value);
    const stdin = vi.spyOn(process, "stdin", "get");
    const stop = vi.fn();
    expect(installGatewayHostLifeline(stop)).toBeUndefined();
    expect(stdin).not.toHaveBeenCalled();
    expect(stop).not.toHaveBeenCalled();
  });

  it.each(["EOF", "error", "already closed"])(
    "requests one stop when the host pipe reaches %s",
    async (reason) => {
      vi.stubEnv("OPENCLAW_GATEWAY_HOST_LIFELINE", "stdin");
      const input = new PassThrough();
      Object.defineProperty(process, "stdin", { configurable: true, get: () => input });
      if (reason === "already closed") {
        input.destroy();
      }
      const stopped = createDeferredCore();
      const stop = vi.fn(() => stopped.resolve());
      const release = installGatewayHostLifeline(stop);
      if (reason === "EOF") {
        input.end();
      } else if (reason === "error") {
        input.destroy(new Error("host pipe failed"));
      }
      await stopped.promise;
      input.emit("close");
      release?.();
      expect(stop).toHaveBeenCalledOnce();
    },
  );

  it("releases its stream listeners when the Gateway stops first", () => {
    vi.stubEnv("OPENCLAW_GATEWAY_HOST_LIFELINE", "stdin");
    const input = new PassThrough();
    Object.defineProperty(process, "stdin", { configurable: true, get: () => input });
    const stop = vi.fn();
    const release = installGatewayHostLifeline(stop);
    release?.();
    input.emit("end");
    input.destroy();
    expect(stop).not.toHaveBeenCalled();
  });
});
