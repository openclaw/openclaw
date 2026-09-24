import { render } from "lit";
import { vi } from "vitest";
import type { GatewayAgentRow, ModelCatalogEntry } from "../../api/types.ts";
import type { ApplicationContext, ApplicationGateway } from "../../app/context.ts";
import { invalidateChatMetadataStore } from "../../lib/chat/chat-metadata-cache.ts";
import { modelCatalogEventInvalidation } from "../../lib/model-catalog-cache.ts";
import { NewSessionModelControl } from "./model-control.ts";

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
      modelCatalogEventInvalidation({ event, payload }) === "clear",
    );
    for (const listener of listeners) {
      listener({ type: "event", event, payload });
    }
  };
  const context = {
    navigate,
    gateway: {
      subscribeEvents: (listener: Parameters<ApplicationGateway["subscribeEvents"]>[0]) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      snapshot: {
        phase: "connected",
        client: { request },
        hello: { features: { methods: featureMethods } },
      },
    },
    sessions: {
      state: {
        result: {
          defaults: {
            model: "openai/gpt-5.6-luna",
            modelProvider: "openai",
            agentRuntime: {
              id: runtime,
              ...(cloudPlacementSupported === undefined ? {} : { cloudPlacementSupported }),
              ...(devicePlacementSupported === undefined ? {} : { devicePlacementSupported }),
              source: "defaults",
            },
          },
          sessions: [],
        },
      },
    },
  } as unknown as ApplicationContext;
  return { context, navigate, request, emitCatalogChanged };
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
  const container = document.createElement("div");
  render(
    control.render({
      ...(agent ? { agent } : {}),
      agentId,
      context,
      sending: false,
    }),
    container,
  );
  return container;
}
