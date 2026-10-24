import type { RouteLocation } from "@openclaw/uirouter";
import { createComponent, createEffect, createSignal } from "solid-js";
import { vi } from "vitest";
import type { GatewayBrowserClient, GatewayHelloOk } from "../../api/gateway.ts";
import type { GatewaySessionRow, SessionsListResult } from "../../api/types.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { createGatewayEvent } from "../../app/gateway-store.test-support.ts";
import { ApplicationProvider } from "../../lib/reactive/context.ts";
import { createApplicationGateway } from "../../test-helpers/application-context-fixtures.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { flush } from "../../test-helpers/solid-settle.ts";
import { createActivityPageState } from "./activity-page-state.ts";
import { ActivityPageView } from "./activity-page-view.tsx";

export type TestActivityPage = ReturnType<typeof createActivityPage>;

export function createActivityContext(
  source: ApplicationContext["gateway"],
  capabilities: Pick<ApplicationContext, "sessions" | "agents" | "agentIdentity">,
  basePath = "",
): ApplicationContext {
  return {
    gateway: source,
    ...capabilities,
    basePath,
    resourceBasePath: "",
    replace: vi.fn(),
    navigate: vi.fn(),
    navigateAndWait: vi.fn(async () => {}),
    revalidate: vi.fn(async () => {}),
    preload: vi.fn(async () => {}),
    nativeDeviceSettings: null,
    nativeNotifications: null,
    // These tests exercise Activity only; unexpected capability reads must fail.
    get router(): never {
      throw new Error("Activity fixture does not provide router");
    },
    get connectionBootstrap(): never {
      throw new Error("Activity fixture does not provide connectionBootstrap");
    },
    get agentSelection(): never {
      throw new Error("Activity fixture does not provide agentSelection");
    },
    get settingsAgentSelection(): never {
      throw new Error("Activity fixture does not provide settingsAgentSelection");
    },
    get channels(): never {
      throw new Error("Activity fixture does not provide channels");
    },
    get config(): never {
      throw new Error("Activity fixture does not provide config");
    },
    get scopeUpgrade(): never {
      throw new Error("Activity fixture does not provide scopeUpgrade");
    },
    get sidebarAttention(): never {
      throw new Error("Activity fixture does not provide sidebarAttention");
    },
    get runtimeConfig(): never {
      throw new Error("Activity fixture does not provide runtimeConfig");
    },
    get placementStartup(): never {
      throw new Error("Activity fixture does not provide placementStartup");
    },
    get plugins(): never {
      throw new Error("Activity fixture does not provide plugins");
    },
    get assistantDock(): never {
      throw new Error("Activity fixture does not provide assistantDock");
    },
    get overlays(): never {
      throw new Error("Activity fixture does not provide overlays");
    },
    get navigation(): never {
      throw new Error("Activity fixture does not provide navigation");
    },
    get theme(): never {
      throw new Error("Activity fixture does not provide theme");
    },
    get nativeChatDrafts(): never {
      throw new Error("Activity fixture does not provide nativeChatDrafts");
    },
    get webPush(): never {
      throw new Error("Activity fixture does not provide webPush");
    },
    get chatSubmissions(): never {
      throw new Error("Activity fixture does not provide chatSubmissions");
    },
    get chatAttachmentHandoff(): never {
      throw new Error("Activity fixture does not provide chatAttachmentHandoff");
    },
  };
}

export function createActivityPage(context: ApplicationContext, initial?: RouteLocation) {
  const [location, setLocation] = createSignal(initial);
  const mounted = mountSolid(() =>
    createComponent(ApplicationProvider, {
      value: context,
      get children() {
        const page = createActivityPageState(context);
        createEffect(location, (next) => page.setRouteLocation(next));
        return createComponent(ActivityPageView, { page });
      },
    }),
  );
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
  const entries = page.container.querySelectorAll(".activity-entry__preview");
  return Array.from(entries, (entry) => entry.textContent);
}

export function expandFirst(page: TestActivityPage) {
  flush();
  const row = page.container.querySelector<HTMLDetailsElement>(".activity-entry")!;
  row.open = true;
  row.dispatchEvent(new Event("toggle"));
  flush();
  return row;
}

export function toolEvent(id: string, sessionKey = "main", name = "read", runId = `run-${id}`) {
  const data = { toolCallId: id, name, phase: "result", result: { text: `${id} output` } };
  return createGatewayEvent("session.tool", { stream: "tool", runId, sessionKey, data });
}

export const activityHello = (recoveryScope = "activity-owner-a"): GatewayHelloOk => ({
  type: "hello-ok",
  protocol: 1,
  auth: { role: "operator", scopes: ["operator.read"], recoveryScope },
});

export function createActivityGatewayStub(): ApplicationContext["gateway"] {
  const snapshot = { ...createApplicationGateway().gateway.snapshot, sessionKey: "main" };
  // SAFETY: Static route tests only read the snapshot and register these observers.
  return {
    snapshot,
    eventLog: [],
    eventLogRevision: 0,
    subscribe: vi.fn(() => () => undefined),
    subscribeEventLog: vi.fn(() => () => undefined),
    subscribeEvents: vi.fn(() => () => undefined),
  } as unknown as ApplicationContext["gateway"];
}

export function inspectorGateway(client: GatewayBrowserClient) {
  const source = createActivityGatewayStub();
  const hello = { ...activityHello(), features: { methods: ["audit.run.inspect"], events: [] } };
  Object.assign(source.snapshot, { client, phase: "connected", hello });
  return source;
}

export function activityRoster(
  sessions: GatewaySessionRow[] = [
    { key: "main", kind: "direct", hasActiveRun: true },
    { key: "agent:other:work", kind: "direct", hasActiveRun: true },
  ],
): SessionsListResult {
  const defaults = { model: null, modelProvider: null, contextTokens: null };
  return { ts: 1, path: "", count: sessions.length, sessions, defaults };
}

export const activityResponse = (method: string, params: unknown) =>
  method === "sessions.list"
    ? activityRoster()
    : method === "sessions.subscribe"
      ? { subscribed: true }
      : method === "sessions.messages.subscribe"
        ? params
        : {};
