import { createSignal } from "solid-js";
import { vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../../app/context.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import {
  createApplicationGateway,
  createSolidApplicationContextProvider,
} from "../../test-helpers/solid-application-context.tsx";
import { meetingPage as paginatedMeetingPage } from "../../test-helpers/transcripts.test-support.ts";
import { MeetingsPage } from "./meetings-page.tsx";

export const meetingPage = { ...paginatedMeetingPage, nextCursor: null };

export function mount(request: ReturnType<typeof vi.fn>, search = "", scopes = ["operator.admin"]) {
  const snapshot = {
    client: { request } as unknown as GatewayBrowserClient,
    phase: "connected",
    hello: { auth: { role: "operator", scopes } },
  } as ApplicationGatewaySnapshot;
  const page = document.createElement("div");
  const [routeSearch, setSearch] = createSignal(search);
  const navigate = vi.fn((_route: string, options: { search: string }) => {
    setSearch(options.search);
  });
  const { gateway, publish } = createApplicationGateway(snapshot);
  const context = { basePath: "", navigate, gateway } as unknown as ApplicationContext;
  const provider = createSolidApplicationContextProvider(context);
  document.body.append(page);
  const mounted = mountSolid(() => <MeetingsPage routeSearch={routeSearch()} />, {
    container: page,
    wrapper: provider.wrapper,
  });
  return {
    page,
    setSearch,
    routeSearch,
    snapshot,
    notify: () => publish(snapshot),
    unmount: () => {
      mounted.unmount();
      page.remove();
    },
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
