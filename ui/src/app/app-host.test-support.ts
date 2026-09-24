import type { RouteLocation } from "@openclaw/uirouter";
import { vi } from "vitest";
import type { ApplicationRouter, RouteId } from "../app-routes.ts";
import type { ApplicationContext } from "./context.ts";

export type ShellKeyboardState = {
  runtime: { context: ApplicationContext };
  handleDocumentKeydown: (event: KeyboardEvent) => void;
};

export function resetAppHostTestGlobals(): void {
  vi.useRealTimers();
  Reflect.deleteProperty(window, "webkit");
  document.documentElement.classList.remove(
    "openclaw-native-macos",
    "openclaw-native-nav",
    "openclaw-native-web-chrome",
  );
  vi.unstubAllGlobals();
}

export type TestOptionalCustomElement = {
  tagName: string;
  label: string;
  loadModule: () => Promise<unknown>;
};

let lazyElementSequence = 0;

export function createLazyElementSpec(
  label: string,
  options: { firstError?: Error } = {},
): TestOptionalCustomElement {
  lazyElementSequence += 1;
  const tagName = `openclaw-app-host-lazy-${lazyElementSequence}`;
  let attempt = 0;
  return {
    tagName,
    label,
    loadModule: async () => {
      attempt += 1;
      if (attempt === 1 && options.firstError) {
        throw options.firstError;
      }
      customElements.define(tagName, class extends HTMLElement {});
    },
  };
}

/**
 * Replay is gated on the rendered element; harnesses that model "rendered as
 * soon as the module defines the tag" install this stub on the fake shell.
 */
export function stubRenderedWhenDefined(shell: object): void {
  Object.defineProperty(shell, "queryRenderedElement", {
    configurable: true,
    value: (tagName: string) =>
      customElements.get(tagName) ? document.createElement(tagName) : null,
  });
}

export function committedRouterState(
  routeId: RouteId,
  pathname: string,
  data?: unknown,
): ReturnType<ApplicationRouter["getState"]> {
  const location = { pathname, search: "", hash: "" } satisfies RouteLocation;
  return {
    location,
    resolvedLocation: location,
    status: "success",
    matches: [{ routeId, location, data }],
    pendingMatches: [],
    cachedMatches: [],
  } as unknown as ReturnType<ApplicationRouter["getState"]>;
}
