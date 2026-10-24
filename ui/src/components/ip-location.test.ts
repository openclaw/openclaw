/* @vitest-environment jsdom */

import { flush } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { mountSolid } from "../test-helpers/solid-render.tsx";
import { IpLocation } from "./ip-location.tsx";

function jsonResponse(body: unknown) {
  return { ok: true, status: 200, json: async () => body } as Response;
}

async function settleUntil(predicate: () => boolean) {
  await vi.waitFor(() => expect(predicate()).toBe(true));
}

function mountLocation(ip?: string) {
  const container = document.createElement("div");
  document.body.append(container);
  const view = mountSolid(IpLocation, { ip }, container);
  onTestFinished(() => {
    view.dispose();
    container.remove();
  });
  return { ...view, element: container.querySelector<HTMLElement>("openclaw-ip-location")! };
}

beforeEach(() => {
  document.body.innerHTML = "";
});
afterEach(() => {
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
function mockFetch(body: unknown) {
  const fetch = vi.fn(async () => jsonResponse(body));
  vi.stubGlobal("fetch", fetch);
  return fetch;
}
async function settle() {
  await vi.advanceTimersByTimeAsync(0);
  flush();
}

describe("openclaw-ip-location", () => {
  it("renders the city with its attribution link and clears a removed address", async () => {
    mockFetch({
      found: true,
      city: "Vienna",
      region: "Vienna",
      attribution: { text: "IP Geolocation by DB-IP", url: "https://db-ip.com" },
    });
    const view = mountLocation("203.0.113.20");
    const element = view.element;

    await settleUntil(() => (element.textContent ?? "").includes("Vienna, Vienna"));

    expect(element.querySelector("a")?.getAttribute("href")).toBe("https://db-ip.com");
    expect(element.querySelector("a")?.getAttribute("aria-label")).toBe("IP Geolocation by DB-IP");
    expect(element.querySelector("a svg")).not.toBeNull();

    view.update({ ip: undefined });
    flush();

    expect(element.textContent?.trim()).toBe("");
    expect(element.querySelector("a")).toBeNull();
  });

  it("renders nothing when the address cannot be placed", async () => {
    const fetch = mockFetch({ found: false });
    const view = mountLocation("203.0.113.21");
    const element = view.element;

    await vi.waitFor(() => expect(fetch).toHaveBeenCalled());
    flush();
    expect(element.textContent?.trim()).toBe("");
  });

  it("clears the previous location while a replacement address is pending", async () => {
    const replacement = createDeferred<Response>();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ found: true, city: "Vienna", country: "Austria" }))
      .mockReturnValueOnce(replacement.promise);
    vi.stubGlobal("fetch", fetchMock);
    const view = mountLocation("203.0.113.24");
    const element = view.element;
    await settleUntil(() => element.textContent?.trim() === "Vienna, Austria");

    view.update({ ip: "203.0.113.25" });
    flush();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(element.textContent?.trim()).toBe("");

    replacement.resolve(jsonResponse({ found: true, city: "Berlin", country: "Germany" }));
    await settleUntil(() => element.textContent?.trim() === "Berlin, Germany");
  });

  it("resumes an unavailable lookup when the component remounts", async () => {
    vi.useFakeTimers();
    const first = createDeferred<Response>();
    const recovered = createDeferred<Response>();
    const fetchMock = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(recovered.promise);
    vi.stubGlobal("fetch", fetchMock);
    let view = mountLocation("203.0.113.22");
    flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    first.resolve({ ok: false, status: 503 } as Response);
    await vi.advanceTimersByTimeAsync(0);
    view.dispose();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    view = mountLocation("203.0.113.22");
    const element = view.element;
    flush();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    recovered.resolve(jsonResponse({ found: true, city: "Berlin", country: "Germany" }));
    await settle();
    expect(element.textContent?.trim()).toBe("Berlin, Germany");
  });

  it("ignores detached completion and reads the cached result after remounting", async () => {
    vi.useFakeTimers();
    const response = createDeferred<Response>();
    const fetchMock = vi.fn().mockReturnValue(response.promise);
    vi.stubGlobal("fetch", fetchMock);
    let view = mountLocation("203.0.113.23");
    let element = view.element;
    flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    view.dispose();
    response.resolve(jsonResponse({ found: true, city: "Vienna", country: "Austria" }));
    await settle();
    expect(element.textContent?.trim()).toBe("");

    view = mountLocation("203.0.113.23");
    element = view.element;
    await settle();
    expect(element.textContent?.trim()).toBe("Vienna, Austria");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    view.dispose();
    view = mountLocation();
    element = view.element;
    await settle();
    expect(element.textContent?.trim()).toBe("");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
