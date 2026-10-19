import type { RouteLocation } from "@openclaw/uirouter";
import { createComponent, createEffect, createSignal } from "solid-js";
import type { ApplicationContext } from "../../app/context.ts";
import { createGatewayEvent } from "../../app/gateway-store.test-support.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { flush } from "../../test-helpers/solid-settle.ts";
import { createActivityPageState } from "./activity-page-state.ts";
import { ActivityPageView } from "./activity-page-view.tsx";

export type TestActivityPage = ReturnType<typeof createActivityPage>;

export function createActivityPage(context: ApplicationContext, initial?: RouteLocation) {
  const [location, setLocation] = createSignal(initial);
  const mounted = mountSolid(() => {
    const page = createActivityPageState(context);
    createEffect(location, (next) => page.setRouteLocation(next));
    return createComponent(ActivityPageView, { page });
  });
  flush();
  return {
    context,
    container: mounted.container,
    dispose: mounted.unmount,
    setRouteLocation(next: RouteLocation | undefined) {
      setLocation(next);
      flush();
    },
  };
}

export function previews(page: TestActivityPage) {
  flush();
  return [...page.container.querySelectorAll(".activity-entry__preview")].map(
    (entry) => entry.textContent,
  );
}

export function expandFirst(page: TestActivityPage) {
  flush();
  const row = page.container.querySelector<HTMLDetailsElement>(".activity-entry")!;
  row.open = true;
  row.dispatchEvent(new Event("toggle"));
  flush();
  return row;
}

export function mountActivityPage(page: TestActivityPage) {
  return page.container;
}

export function toolEvent(id: string, sessionKey = "main", name = "read", runId = `run-${id}`) {
  return createGatewayEvent("session.tool", {
    stream: "tool",
    runId,
    sessionKey,
    data: {
      toolCallId: id,
      name,
      phase: "result",
      result: { text: `${id} output` },
    },
  });
}
