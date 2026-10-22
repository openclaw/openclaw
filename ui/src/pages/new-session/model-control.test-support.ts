import { expect, onTestFinished, vi } from "vitest";
import type { GatewayAgentRow, ModelCatalogEntry } from "../../api/types.ts";
import type { ApplicationContext, ApplicationGateway } from "../../app/context.ts";
import { invalidateChatMetadataStore } from "../../lib/chat/chat-metadata-cache.ts";
import { modelCatalogEventInvalidation } from "../../lib/model-catalog-cache.ts";
import { mountSolid } from "../../test-helpers/solid-render.tsx";
import { flush, waitForSolid } from "../../test-helpers/solid-settle.ts";
import { NewSessionModelControlView } from "./model-control-view.tsx";
import { NewSessionModelControl } from "./model-control.ts";

type ViewProps = Parameters<typeof NewSessionModelControlView>[0];
const views = new WeakMap<NewSessionModelControl, ReturnType<typeof mountSolid<ViewProps>>>();
const openedPickers = new WeakSet<HTMLDetailsElement>();
const subscribe =
  <T>(listeners: Set<T>) =>
  (listener: T) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };

export function contextWith(
  models: ModelCatalogEntry[],
  runtime = "openclaw",
  featureMethods: string[] = [],
  cloudPlacementSupported?: boolean,
  devicePlacementSupported?: boolean,
) {
  const request = vi.fn().mockResolvedValue({ models });
  const navigate = vi.fn();
  const listeners = new Set<Parameters<ApplicationGateway["subscribeEvents"]>[0]>();
  const emitCatalogChanged = (
    event: "config.changed" | "chat.metadata.changed" = "chat.metadata.changed",
    payload: unknown = {},
  ) => {
    invalidateChatMetadataStore(
      context.gateway.snapshot.client!,
      undefined,
      undefined,
      modelCatalogEventInvalidation({ event, payload }) ?? "preserve",
    );
    listeners.forEach((listener) => listener({ type: "event", event, payload }));
  };
  const ownerListeners = {
    gateway: new Set<() => void>(),
    agents: new Set<() => void>(),
    sessions: new Set<() => void>(),
    config: new Set<() => void>(),
  };
  const publish = (owner: keyof typeof ownerListeners) =>
    ownerListeners[owner].forEach((listener) => listener());
  const defaults = {
    model: "openai/gpt-5.6-luna",
    modelProvider: "openai",
    agentRuntime: {
      id: runtime,
      ...(cloudPlacementSupported === undefined ? {} : { cloudPlacementSupported }),
      ...(devicePlacementSupported === undefined ? {} : { devicePlacementSupported }),
      source: "defaults",
    },
  };
  const context = {
    navigate,
    agents: { subscribe: subscribe(ownerListeners.agents) },
    config: { subscribe: subscribe(ownerListeners.config), current: {} },
    gateway: {
      subscribe: subscribe(ownerListeners.gateway),
      subscribeEvents: subscribe(listeners),
      snapshot: {
        phase: "connected",
        client: { request },
        hello: { features: { methods: featureMethods } },
      },
    },
    sessions: {
      subscribe: subscribe(ownerListeners.sessions),
      state: { result: { defaults, sessions: [] } },
    },
  } as unknown as ApplicationContext;
  return { context, navigate, request, emitCatalogChanged, publish, ownerListeners };
}

export function renderControl(
  control: NewSessionModelControl,
  context: ApplicationContext,
  agentId = "main",
  agent: GatewayAgentRow | null = {
    id: "main",
    model: { primary: "openai/gpt-5.6-luna" },
    thinkingDefault: "medium",
  },
) {
  const props: ViewProps = {
    control,
    options: { ...(agent ? { agent } : {}), agentId, context, sending: false },
  };
  let view = views.get(control);
  if (view) {
    view.update(props);
  } else {
    const container = document.body.appendChild(document.createElement("div"));
    view = mountSolid(NewSessionModelControlView, props, container);
    views.set(control, view);
    onTestFinished(() => {
      views.delete(control);
      container.remove();
    });
  }
  const container = view.container;
  for (const picker of container.querySelectorAll<HTMLDetailsElement>(
    ".chat-controls__model-picker[data-chat-native-picker], .chat-controls__effort-picker[data-chat-native-picker]",
  )) {
    if (openedPickers.has(picker)) {
      continue;
    }
    openedPickers.add(picker);
    picker.open = true;
    picker.dispatchEvent(new Event("toggle"));
    flush();
  }
  return container;
}

export async function waitForModelControl(...params: Parameters<typeof renderControl>) {
  const container = renderControl(...params);
  await waitForSolid(() =>
    expect(container.querySelector(".chat-controls__model-menu")).not.toBeNull(),
  );
  return container;
}
