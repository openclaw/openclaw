import { createRouter } from "@openclaw/uirouter";
import { flush } from "solid-js";
import { expect, onTestFinished, vi } from "vitest";
import type { WebSearchStatusResult } from "../../../../packages/gateway-protocol/src/schema/web-search.ts";
import type {
  ApplicationContext,
  ApplicationGateway,
  ApplicationGatewaySnapshot,
} from "../../app/context.ts";
import { i18n } from "../../i18n/lib/translate.ts";
import { ApplicationProvider } from "../../lib/reactive/context.ts";
import {
  createGatewayRequestMock,
  createTestGatewayClient,
  type GatewayRequestHandler,
} from "../../test-helpers/gateway-client.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { createApplicationGateway } from "../../test-helpers/solid-application-context.tsx";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import { SearchPage } from "./search-page.tsx";

export const searchPath = ["tools", "web", "search"];
export const providerPath = (id: string) => ["plugins", "entries", id, "config", "webSearch"];
export function atPath(path: string[], value: unknown): Record<string, unknown> {
  return path.slice(0, -1).reduceRight((node, key) => ({ [key]: node }), { [path.at(-1)!]: value });
}
export function searchStatus(
  id: string,
  label: string,
  provider: Partial<WebSearchStatusResult["providers"][number]> = {},
  status: Partial<WebSearchStatusResult> = {},
): WebSearchStatusResult {
  return {
    enabled: true,
    provider: null,
    agentId: "main",
    model: { provider: "example", id: "local", runtime: "pi" },
    route: { kind: "managed", provider: id, label, testable: true },
    providers: [
      {
        id,
        pluginId: id,
        label,
        hint: label,
        configured: true,
        installed: true,
        available: true,
        requiresCredential: false,
        credentialSource: "none",
        configPath: providerPath(id),
        ...provider,
      },
    ],
    ...status,
  };
}

export function observable<T>(state: T) {
  const listeners = new Set<() => void>();
  return {
    state,
    publish: () => {
      for (const listener of listeners) {
        listener();
      }
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export function editInput(input: HTMLInputElement, value: string, blur = true) {
  input.focus();
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  if (blur) {
    input.blur();
  }
}

export async function mountSearch<R>(options: {
  respond: GatewayRequestHandler;
  runtime: (gateway: ApplicationGateway, snapshot: ApplicationGatewaySnapshot) => R | Promise<R>;
  hello?: ApplicationGatewaySnapshot["hello"];
  waitReady?: boolean;
  waitForRefresh?: boolean;
  agents?: string[];
  cleanup?: (runtime: R) => void;
}) {
  const pending: { method: string; response: Promise<unknown> }[] = [];
  const request = createGatewayRequestMock((method, params) => {
    const response = Promise.resolve(options.respond(method, params));
    pending.push({ method, response });
    return response;
  });
  let client = createTestGatewayClient(request);
  const snapshot = {
    phase: "connected",
    client,
    sessionKey: "main",
    hello: options.hello,
  } as ApplicationGatewaySnapshot;
  const connection = createApplicationGateway(snapshot);
  const runtime = await options.runtime(connection.gateway, snapshot);
  const selection = observable({ selectedId: "main" });
  const setAgent = (id: string) => {
    selection.state.selectedId = id;
    selection.publish();
  };
  const navigate = vi.fn();
  const agents = (options.agents ?? ["main", "scout"]).map((id) => ({
    id,
    name: id === "main" ? "Main" : "Scout",
  }));
  const context = {
    basePath: "",
    router: createRouter({ routes: [] }),
    gateway: connection.gateway,
    runtimeConfig: runtime,
    settingsAgentSelection: { ...selection, set: setAgent },
    navigate,
    agents: {
      state: { agentsList: { agents } },
      subscribe: () => () => {},
    },
  } as unknown as ApplicationContext;
  const view = mountSolid(() => (
    <ApplicationProvider value={context}>
      <SearchPage />
    </ApplicationProvider>
  ));
  const element = view.container;
  const button = (text: string) => {
    const control = [...element.querySelectorAll("button")].find(
      (candidate) =>
        (
          candidate.querySelector(".settings-row__title")?.textContent ?? candidate.textContent
        )?.trim() === text,
    );
    expect(control, text).toBeDefined();
    return control!;
  };
  const input = (label: string) =>
    element.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
  onTestFinished(() => {
    view.unmount();
    options.cleanup?.(runtime);
  });
  const settle = async (includeTests = false) => {
    flush();
    await Promise.allSettled(
      pending
        .filter(
          ({ method }) => method !== "config.set" && (includeTests || method !== "webSearch.test"),
        )
        .map(({ response }) => response),
    );
    flush();
    if (options.waitForRefresh) {
      await waitForSolid(() => expect(button(i18n.t("searchPage.refresh")).disabled).toBe(false));
    }
  };
  if (options.waitReady === false) {
    flush();
  } else {
    await settle();
  }
  return {
    element,
    runtime,
    navigate,
    snapshot,
    gateway: connection,
    button,
    input,
    setAgent,
    settle,
    click: (label: string) => button(label).click(),
    edit: (label: string, value: string, blur = true) => {
      const field = input(label);
      expect(field).not.toBeNull();
      editInput(field, value, blur);
      return field;
    },
    select: (label: string, value: string) => {
      const field = element.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)!;
      expect(field).not.toBeNull();
      field.value = value;
      field.dispatchEvent(new Event("change", { bubbles: true }));
    },
    calls: (method: string) => request.mock.calls.filter(([name]) => name === method),
    statuses: () =>
      [...element.querySelectorAll('[role="status"]')].map((region) => region.textContent),
    dispose: () => view.unmount(),
    replaceConnection: () => {
      client = createTestGatewayClient(request);
      connection.publish({ ...connection.gateway.snapshot, client });
    },
  };
}
