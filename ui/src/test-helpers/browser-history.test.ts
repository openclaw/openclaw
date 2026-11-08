/* @vitest-environment jsdom */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { installBrowserHistoryIsolation } from "./browser-history.ts";

describe("browser history isolation", { concurrent: false }, () => {
  installBrowserHistoryIsolation();
  const baselineUrl = "/history-baseline?view=retained#anchor";
  let outerLocation: { state: unknown; url: string };

  beforeAll(() => {
    outerLocation = {
      state: window.history.state,
      url: `${window.location.pathname}${window.location.search}${window.location.hash}`,
    };
    window.history.replaceState({ retained: true }, "", baselineUrl);
  });

  afterAll(() => {
    window.history.replaceState(outerLocation.state, "", outerLocation.url);
  });

  it("allows a test to replace both its route and history state", () => {
    window.history.replaceState({ isolated: true }, "", "/settings/appearance?tab=test#details");

    expect(window.history.state).toEqual({ isolated: true });
    expect(window.location.pathname).toBe("/settings/appearance");
  });

  it("restores both route and history state before the next test", () => {
    expect(window.history.state).not.toEqual({ isolated: true });
    expect(window.location.pathname).not.toBe("/settings/appearance");
    expect(window.location.search).not.toBe("?tab=test");
    expect(window.location.hash).not.toBe("#details");
    expect(window.history.state).toEqual({ retained: true });
    expect(`${window.location.pathname}${window.location.search}${window.location.hash}`).toBe(
      baselineUrl,
    );
  });
});
