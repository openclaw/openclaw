import { vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../../app/context.ts";
import { meetingPage as paginatedMeetingPage } from "../../test-helpers/transcripts.test-support.ts";
import "./meetings-page.ts";

export const meetingPage = { ...paginatedMeetingPage, nextCursor: null };

type TestPage = HTMLElement & {
  context: ApplicationContext;
  routeSearch: string;
  updateComplete: Promise<boolean>;
};

export function mount(request: ReturnType<typeof vi.fn>, search = "", scopes = ["operator.admin"]) {
  const listeners = new Set<(snapshot: ApplicationGatewaySnapshot) => void>();
  const snapshot = {
    client: { request } as unknown as GatewayBrowserClient,
    phase: "connected",
    hello: { auth: { role: "operator", scopes } },
  } as ApplicationGatewaySnapshot;
  const page = document.createElement("openclaw-meetings-page") as TestPage;
  const navigate = vi.fn((_route: string, options: { search: string }) => {
    page.routeSearch = options.search;
  });
  page.context = {
    basePath: "",
    navigate,
    gateway: {
      snapshot,
      subscribe: (listener: (snapshot: ApplicationGatewaySnapshot) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
  } as unknown as ApplicationContext;
  page.routeSearch = search;
  document.body.append(page);
  return {
    page,
    snapshot,
    notify: () => listeners.forEach((listener) => listener(snapshot)),
    navigate,
  };
}

export function button(page: Element, text: string) {
  const result = [...page.querySelectorAll<HTMLButtonElement>("button")].find(
    (entry) => entry.textContent?.trim() === text,
  );
  if (!result) {
    throw new Error(`Missing button: ${text}`);
  }
  return result;
}
