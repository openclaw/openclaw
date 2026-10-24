/* @vitest-environment jsdom */

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createMobileSheetScrollFades } from "./chat-mobile-scroll-fades.ts";

const releases: Array<() => void> = [];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame"] });
});

afterEach(() => {
  for (const release of releases.splice(0)) {
    release();
  }
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

function shell() {
  const element = document.createElement("section");
  element.style.backgroundColor = "rgb(10, 20, 30)";
  vi.spyOn(element, "getBoundingClientRect").mockReturnValue(new DOMRect(10, 20, 300, 400));
  document.body.append(element);
  return element;
}

function port(parent: HTMLElement, left: number) {
  const element = document.createElement("div");
  element.style.overflowY = "auto";
  Object.defineProperties(element, {
    clientHeight: { value: 100 },
    clientWidth: { value: 180 },
    clientLeft: { value: 2 },
    clientTop: { value: 3 },
    scrollHeight: { value: 300 },
  });
  vi.spyOn(element, "getBoundingClientRect").mockReturnValue(new DOMRect(left, 50, 200, 100));
  element.scrollTop = 25;
  parent.append(element);
  return element;
}

function edges(host: HTMLElement) {
  return [...host.querySelectorAll<HTMLElement>(".chat-mobile-host__scroll-edge")];
}

it("paints retained and late scroll ports in document order with the existing inset and surface", () => {
  const host = shell();
  const first = port(host, 30);
  const second = port(host, 50);
  const fades = createMobileSheetScrollFades();
  releases.push(fades.register(second), fades.register(first), fades.connect(host));
  vi.advanceTimersToNextFrame();

  expect(edges(host).map((edge) => edge.style.left)).toEqual(["22px", "22px", "42px", "42px"]);
  const top = edges(host)[0]!;
  const bottom = edges(host)[1]!;
  expect(top.style.top).toBe("33px");
  expect(bottom.style.top).toBe("123px");
  expect(top.style.width).toBe("180px");
  expect(top.style.getPropertyValue("--mobile-fade-surface")).toBe("rgb(10, 20, 30)");
  expect([top.hidden, bottom.hidden]).toEqual([false, false]);

  const nested = port(first, 40);
  releases.push(fades.register(nested));
  vi.advanceTimersToNextFrame();
  expect(edges(host).map((edge) => edge.style.left)).toEqual([
    "22px",
    "22px",
    "32px",
    "32px",
    "42px",
    "42px",
  ]);
  expect(edges(host)[0]).toBe(top);
  expect(edges(host)[1]).toBe(bottom);

  first.scrollTop = 0;
  first.dispatchEvent(new Event("scroll"));
  vi.advanceTimersToNextFrame();
  expect([top.hidden, bottom.hidden]).toEqual([true, false]);
  first.scrollTop = 200;
  first.dispatchEvent(new Event("scroll"));
  vi.advanceTimersToNextFrame();
  expect([top.hidden, bottom.hidden]).toEqual([false, true]);
});

it("reconnects retained ports only within the current shell and releases disposed ports", async () => {
  const firstHost = shell();
  const nextHost = shell();
  const retained = port(firstHost, 30);
  const outside = port(nextHost, 50);
  const fades = createMobileSheetScrollFades();
  const releaseRetained = fades.register(retained);
  releases.push(releaseRetained, fades.register(outside));
  const disconnect = fades.connect(firstHost);
  vi.advanceTimersToNextFrame();
  expect(edges(firstHost)).toHaveLength(2);
  expect(edges(nextHost)).toHaveLength(0);

  disconnect();
  expect(firstHost.querySelector(".chat-mobile-host__scroll-fades")).toBeNull();
  retained.dispatchEvent(new Event("scroll"));
  vi.advanceTimersToNextFrame();
  expect(edges(firstHost)).toHaveLength(0);

  nextHost.prepend(retained);
  releases.push(fades.connect(nextHost));
  vi.advanceTimersToNextFrame();
  expect(edges(nextHost)).toHaveLength(4);
  releaseRetained();
  expect(edges(nextHost)).toHaveLength(2);

  outside.remove();
  await Promise.resolve();
  vi.advanceTimersToNextFrame();
  expect(edges(nextHost)).toHaveLength(0);
  retained.dispatchEvent(new Event("scroll"));
  vi.advanceTimersToNextFrame();
  expect(edges(nextHost)).toHaveLength(0);
});
