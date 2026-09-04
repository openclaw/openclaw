import { PassThrough } from "node:stream";
import { expect, it, vi } from "vitest";
import { pipeProcessOutput } from "./pipe-output.js";

it.each(["dispose", "destination close", "destination error", "source close"])(
  "releases destination listeners after %s without owning the destination lifetime",
  async (ending) => {
    const source = new PassThrough();
    const destination = new PassThrough();
    const reportError = vi.fn();
    const dispose = pipeProcessOutput(source, destination, reportError);
    source.write("diagnostic");
    expect(destination.read()?.toString()).toBe("diagnostic");
    const failure = new Error("diagnostic destination failed");
    if (ending === "dispose") {
      dispose();
    } else if (ending === "destination close") {
      destination.destroy();
    } else if (ending === "destination error") {
      destination.destroy(failure);
    } else {
      source.destroy();
    }
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(destination.listenerCount("drain")).toBe(0);
    expect(destination.listenerCount("error")).toBe(0);
    expect(destination.listenerCount("close")).toBe(0);
    expect(reportError.mock.calls).toEqual(ending === "destination error" ? [[failure]] : []);
    if (ending === "dispose" || ending === "source close") {
      expect(destination.destroyed).toBe(false);
      expect(destination.writableEnded).toBe(false);
    }
    dispose();
    source.destroy();
    destination.destroy();
  },
);
