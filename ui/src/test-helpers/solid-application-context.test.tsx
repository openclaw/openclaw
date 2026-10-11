import { onCleanup } from "solid-js";
import { expect, it, vi } from "vitest";
import type { ApplicationContext } from "../app/context-types.ts";
import { projectGateway, projectGatewayEvents } from "../lib/reactive/application.ts";
import { useApplication } from "../lib/reactive/context.ts";
import { mountSolid } from "./mount-solid.ts";
import {
  createApplicationGateway,
  createSolidApplicationContextProvider,
} from "./solid-application-context.tsx";
import { flush } from "./solid-settle.ts";

function contextFor(gateway: ApplicationContext["gateway"], basePath: string) {
  // These consumers exercise context transport and Gateway observation only.
  return { basePath, resourceBasePath: basePath, gateway } as ApplicationContext;
}

it("provides shared Gateway snapshots/events and retires replaced consumers", () => {
  const first = createApplicationGateway();
  const second = createApplicationGateway();
  const firstContext = contextFor(first.gateway, "/first");
  const secondContext = contextFor(second.gateway, "/second");
  const provider = createSolidApplicationContextProvider(firstContext);
  const seen: ApplicationContext[] = [];
  const retired = vi.fn();
  const events = vi.fn();
  function Consumer() {
    const context = useApplication();
    seen.push(context);
    const gateway = projectGateway(context.gateway);
    const eventStream = projectGatewayEvents(context.gateway);
    eventStream.subscribe(events);
    onCleanup(retired);
    return (
      <output>
        {context.basePath}:{gateway.read().snapshot.phase}
      </output>
    );
  }
  const view = mountSolid(() => <Consumer />, { wrapper: provider.wrapper });
  expect(seen).toEqual([firstContext]);
  expect(view.container.textContent).toBe("/first:stopped");
  expect(firstContext.sidebarAttention.entries).toEqual([]);
  first.publish({ ...first.gateway.snapshot, phase: "connecting" });
  flush();
  expect(view.container.textContent).toBe("/first:connecting");
  const event = { type: "event" as const, event: "tick", payload: { value: 1 } };
  first.publishEvent(event);
  first.publishEvent(event);
  expect(events.mock.calls).toEqual([[event], [event]]);

  provider.setContext(secondContext);
  flush();
  expect(seen).toEqual([firstContext, secondContext]);
  expect(retired).toHaveBeenCalledOnce();
  expect(view.container.textContent).toBe("/second:stopped");
  first.publishEvent(event);
  expect(events).toHaveBeenCalledTimes(2);
  second.publishEvent(event);
  expect(events).toHaveBeenCalledTimes(3);
  second.publish({ ...second.gateway.snapshot, phase: "connecting" });
  flush();
  expect(view.container.textContent).toBe("/second:connecting");
  view.unmount();
  second.publishEvent(event);
  expect(events).toHaveBeenCalledTimes(3);
  expect(retired).toHaveBeenCalledTimes(2);
});

it("keeps nested provider scopes independent", () => {
  const gateway = createApplicationGateway();
  const outer = createSolidApplicationContextProvider(contextFor(gateway.gateway, "/outer"));
  const inner = createSolidApplicationContextProvider(contextFor(gateway.gateway, "/inner"));
  function Consumer() {
    const application = useApplication();
    return <span>{application.basePath}</span>;
  }
  const view = mountSolid(
    () => (
      <>
        <Consumer />
        <inner.wrapper>
          <Consumer />
        </inner.wrapper>
      </>
    ),
    { wrapper: outer.wrapper },
  );
  expect(view.container.textContent).toBe("/outer/inner");
  inner.setContext(contextFor(gateway.gateway, "/replacement"));
  flush();
  expect(view.container.textContent).toBe("/outer/replacement");
});
