import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApplicationContext } from "../../app/context-types.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { SettingsTargetArrival } from "./settings-target-arrival.ts";

function hashRouter(initial: string) {
  let hash = initial;
  const listeners = new Set<() => void>();
  const router = {
    getState: () => ({ location: { pathname: "/settings/search", search: "", hash } }),
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return {
    // SAFETY: the arrival reads only the location hash and subscribes to changes.
    router: router as unknown as ApplicationContext["router"],
    go: (next: string) => {
      hash = next;
      listeners.forEach((listener) => listener());
    },
  };
}

function row(host: HTMLElement, id: string) {
  const element = document.createElement("div");
  element.className = "settings-row";
  element.id = id;
  const scroll = vi.fn();
  element.scrollIntoView = scroll;
  host.append(element);
  return scroll;
}

afterEach(() => document.body.replaceChildren());

describe("SettingsTargetArrival", () => {
  it("brings in a setting that renders after the page, and follows later links", async () => {
    const host = document.createElement("main");
    document.body.append(host);
    const { router, go } = hashRouter("#tools.web.search.provider");
    mountSolid(() => <SettingsTargetArrival router={router} host={() => host} />);
    const late = row(host, "tools.web.search.provider");
    await vi.waitFor(() => expect(late).toHaveBeenCalledOnce());

    const next = row(host, "tools.web.search.enabled");
    go("#tools.web.search.enabled");
    await vi.waitFor(() => expect(next).toHaveBeenCalledOnce());
    expect(late).toHaveBeenCalledOnce();
  });

  it("drops a link the reader replaced before its setting rendered", async () => {
    const host = document.createElement("main");
    document.body.append(host);
    const { router, go } = hashRouter("#tools.web.search.provider");
    mountSolid(() => <SettingsTargetArrival router={router} host={() => host} />);
    go("");
    const late = row(host, "tools.web.search.provider");
    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });
    expect(late).not.toHaveBeenCalled();
  });
});
