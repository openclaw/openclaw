import { describe, expect, it, vi } from "vitest";
import {
  __resetSessionGenerationsForTest,
  beginSessionGeneration,
  isSessionGenerationCurrent,
  registerSessionGenerationListener,
} from "./session-generation.js";

describe("session generation", () => {
  it("treats missing session keys as always current", async () => {
    __resetSessionGenerationsForTest();
    const token = await beginSessionGeneration({});
    expect(token).toBeUndefined();
    expect(isSessionGenerationCurrent(token)).toBe(true);
  });

  it("invalidates older generations when a new turn starts", async () => {
    __resetSessionGenerationsForTest();
    const first = await beginSessionGeneration({ sessionKey: "agent:main:test" });
    const second = await beginSessionGeneration({ sessionKey: "agent:main:test" });
    expect(isSessionGenerationCurrent(first)).toBe(false);
    expect(isSessionGenerationCurrent(second)).toBe(true);
  });

  it("tracks generations independently per session", async () => {
    __resetSessionGenerationsForTest();
    const alpha = await beginSessionGeneration({ sessionKey: "agent:main:alpha" });
    const beta = await beginSessionGeneration({ sessionKey: "agent:main:beta" });
    await beginSessionGeneration({ sessionKey: "agent:main:alpha" });
    expect(isSessionGenerationCurrent(alpha)).toBe(false);
    expect(isSessionGenerationCurrent(beta)).toBe(true);
  });

  it("notifies listeners when a newer generation starts", async () => {
    __resetSessionGenerationsForTest();
    const listener = vi.fn();
    const unsubscribe = registerSessionGenerationListener("agent:main:test", listener);
    await beginSessionGeneration({ sessionKey: "agent:main:test" });
    await beginSessionGeneration({ sessionKey: "agent:main:test" });
    expect(listener).toHaveBeenCalledTimes(2);
    expect(listener).toHaveBeenLastCalledWith({
      sessionKey: "agent:main:test",
      generation: 2,
    });
    unsubscribe();
  });
});
