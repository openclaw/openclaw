/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import "./ip-location.ts";

function jsonResponse(body: unknown) {
  return { ok: true, status: 200, json: async () => body } as Response;
}

// The element resolves through its own fetch, so wait for the asserted text
// rather than a fixed number of update cycles.
async function settleUntil(
  element: HTMLElement & { updateComplete?: Promise<unknown> },
  predicate: () => boolean,
) {
  await vi.waitFor(async () => {
    await element.updateComplete;
    expect(predicate()).toBe(true);
  });
}

beforeEach(() => {
  document.body.innerHTML = "";
});

afterEach(() => {
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("openclaw-ip-location", () => {
  it("renders the city with its attribution link and clears a removed address", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          found: true,
          city: "Vienna",
          region: "Vienna",
          attribution: { text: "IP Geolocation by DB-IP", url: "https://db-ip.com" },
        }),
      ),
    );
    const element = document.createElement("openclaw-ip-location");
    element.ip = "203.0.113.20";
    document.body.append(element);

    await settleUntil(element, () => (element.textContent ?? "").includes("Vienna, Vienna"));

    expect(element.querySelector("a")?.getAttribute("href")).toBe("https://db-ip.com");
    expect(element.querySelector("a")?.getAttribute("aria-label")).toBe("IP Geolocation by DB-IP");
    expect(element.querySelector("a svg")).not.toBeNull();

    element.ip = undefined;
    await element.updateComplete;

    expect(element.textContent?.trim()).toBe("");
    expect(element.querySelector("a")).toBeNull();
  });

  it("renders nothing when the address cannot be placed", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ found: false })),
    );
    const element = document.createElement("openclaw-ip-location");
    element.ip = "203.0.113.21";
    document.body.append(element);

    await settleUntil(
      element,
      () => (fetch as unknown as { mock: { calls: unknown[] } }).mock.calls.length > 0,
    );
    await element.updateComplete;
    expect(element.textContent?.trim()).toBe("");
  });

  it("does not request anything without an address", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const element = document.createElement("openclaw-ip-location");
    document.body.append(element);

    await element.updateComplete;
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("resumes an unavailable lookup when the same element reconnects", async () => {
    vi.useFakeTimers();
    const first = createDeferred<Response>();
    const recovered = createDeferred<Response>();
    const fetchMock = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(recovered.promise);
    vi.stubGlobal("fetch", fetchMock);
    const element = document.createElement("openclaw-ip-location");
    element.ip = "203.0.113.22";
    document.body.append(element);
    await element.updateComplete;
    expect(fetchMock).toHaveBeenCalledTimes(1);

    first.resolve({ ok: false, status: 503 } as Response);
    await vi.advanceTimersByTimeAsync(0);
    element.remove();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    document.body.append(element);
    await element.updateComplete;
    expect(fetchMock).toHaveBeenCalledTimes(2);
    recovered.resolve(jsonResponse({ found: true, city: "Berlin", country: "Germany" }));
    await vi.advanceTimersByTimeAsync(0);
    await element.updateComplete;
    expect(element.textContent?.trim()).toBe("Berlin, Germany");
  });

  it("ignores detached completion and reads the cached result after reconnecting", async () => {
    vi.useFakeTimers();
    const response = createDeferred<Response>();
    const fetchMock = vi.fn().mockReturnValue(response.promise);
    vi.stubGlobal("fetch", fetchMock);
    const element = document.createElement("openclaw-ip-location");
    element.ip = "203.0.113.23";
    document.body.append(element);
    await element.updateComplete;
    expect(fetchMock).toHaveBeenCalledTimes(1);

    element.remove();
    response.resolve(jsonResponse({ found: true, city: "Vienna", country: "Austria" }));
    await vi.advanceTimersByTimeAsync(0);
    await element.updateComplete;
    expect(element.textContent?.trim()).toBe("");

    document.body.append(element);
    await vi.advanceTimersByTimeAsync(0);
    await element.updateComplete;
    expect(element.textContent?.trim()).toBe("Vienna, Austria");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    element.remove();
    element.ip = undefined;
    document.body.append(element);
    await vi.advanceTimersByTimeAsync(0);
    await element.updateComplete;
    expect(element.textContent?.trim()).toBe("");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
