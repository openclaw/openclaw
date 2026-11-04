/* @vitest-environment jsdom */

import { flush } from "solid-js";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { mountSolid } from "../test-helpers/solid-render.tsx";
import { IpLocation } from "./ip-location.tsx";

function jsonResponse(body: unknown) {
  return { ok: true, status: 200, json: async () => body } as Response;
}

function mountLocation(ip?: string) {
  const container = document.createElement("div");
  document.body.append(container);
  const view = mountSolid(IpLocation, { ip }, container);
  onTestFinished(() => {
    view.dispose();
    container.remove();
  });
  const element = container.querySelector<HTMLElement>("openclaw-ip-location")!;
  const text = () => element.textContent?.trim();
  return {
    ...view,
    element,
    text,
    expectText: (expected: string) => vi.waitFor(() => expect(text()).toBe(expected)),
  };
}

afterEach(() => {
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
function mockFetch(...responses: (Response | Promise<Response>)[]) {
  const fetch = vi.fn();
  for (const response of responses) {
    fetch.mockReturnValueOnce(Promise.resolve(response));
  }
  vi.stubGlobal("fetch", fetch);
  return fetch;
}
const located = (city = "Vienna", country = "Austria") =>
  jsonResponse({ found: true, city, country });
async function settle() {
  await vi.advanceTimersByTimeAsync(0);
  flush();
}

describe("openclaw-ip-location", () => {
  it("renders attributed locations and clears them while replacing or removing the address", async () => {
    const replacement = createDeferred<Response>();
    mockFetch(
      jsonResponse({
        found: true,
        city: "Vienna",
        region: "Vienna",
        attribution: { text: "IP Geolocation by DB-IP", url: "https://db-ip.com" },
      }),
      replacement.promise,
    );
    const view = mountLocation("203.0.113.20");
    const element = view.element;

    await view.expectText("Vienna, Vienna");

    expect(element.querySelector("a")?.getAttribute("href")).toBe("https://db-ip.com");
    expect(element.querySelector("a")?.getAttribute("aria-label")).toBe("IP Geolocation by DB-IP");
    expect(element.querySelector("a svg")).not.toBeNull();

    view.update({ ip: "203.0.113.25" });
    flush();
    expect(view.text()).toBe("");
    replacement.resolve(located("Berlin", "Germany"));
    await view.expectText("Berlin, Germany");

    view.update({ ip: undefined });
    flush();

    expect(view.text()).toBe("");
    expect(element.querySelector("a")).toBeNull();
  });

  it("renders nothing when the address cannot be placed", async () => {
    const fetch = mockFetch(jsonResponse({ found: false }));
    const view = mountLocation("203.0.113.21");

    await vi.waitFor(() => expect(fetch).toHaveBeenCalled());
    flush();
    expect(view.text()).toBe("");
  });

  it("resumes an unavailable lookup when the component remounts", async () => {
    vi.useFakeTimers();
    const first = createDeferred<Response>();
    const recovered = createDeferred<Response>();
    const fetchMock = mockFetch(first.promise, recovered.promise);
    let view = mountLocation("203.0.113.22");
    flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    first.resolve({ ok: false, status: 503 } as Response);
    await vi.advanceTimersByTimeAsync(0);
    view.dispose();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    view = mountLocation("203.0.113.22");
    flush();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    recovered.resolve(located("Berlin", "Germany"));
    await settle();
    expect(view.text()).toBe("Berlin, Germany");
  });

  it("ignores detached completion and reads the cached result after remounting", async () => {
    vi.useFakeTimers();
    const response = createDeferred<Response>();
    const fetchMock = mockFetch(response.promise);
    let view = mountLocation("203.0.113.23");
    flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    view.dispose();
    response.resolve(located());
    await settle();
    expect(view.text()).toBe("");

    view = mountLocation("203.0.113.23");
    await settle();
    expect(view.text()).toBe("Vienna, Austria");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    view.dispose();
    view = mountLocation();
    await settle();
    expect(view.text()).toBe("");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
