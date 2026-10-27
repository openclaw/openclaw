/* @vitest-environment jsdom */
import { createRouter } from "@openclaw/uirouter";
import { expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewaySessionRow } from "../../api/types.ts";
import type { RouteId } from "../../app-route-paths.ts";
import type { ApplicationContext } from "../../app/context.ts";
import type { LobsterPetProps } from "../../components/lobster-pet-contract.ts";
import { sessionsResult } from "../../lib/sessions/session-capability.test-support.ts";
import { createApplicationContextProvider } from "../../test-helpers/application-context.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import { flush, waitForSolid } from "../../test-helpers/solid-settle.ts";
import {
  createGatewayBrowserClientFixture,
  createSessionContext,
} from "../chat/chat-application-context.test-support.ts";
import "./new-session-page-entry.ts";
import { createNewSessionRouteData as routeData } from "./location.test-support.ts";
import { NewSessionPageOwner, type PageHost } from "./new-session-page-owner.ts";

async function mountSessionDraft() {
  vi.stubGlobal("requestIdleCallback", (callback: IdleRequestCallback) => {
    queueMicrotask(() => callback({ didTimeout: false, timeRemaining: () => 50 }));
    return 1;
  });
  vi.stubGlobal("cancelIdleCallback", () => {});
  onTestFinished(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });
  const recent: GatewaySessionRow = {
    key: "agent:main:dashboard:recent",
    sessionId: "recent-session",
    kind: "direct",
    label: "Recent research",
    updatedAt: 100,
    status: "done",
  };
  const pin: GatewaySessionRow = {
    key: "agent:main:dashboard:pin",
    sessionId: "pinned-session",
    kind: "direct",
    label: "Saved research",
    updatedAt: 1,
    rowMode: "sidebar",
    status: "done",
  };
  const result = sessionsResult([recent, pin]);
  result.defaults = { modelProvider: "openai", model: "initial-model", contextTokens: null };
  const defaults = createDeferred<{ defaults: Array<{ name: string }> }>();
  let described: GatewaySessionRow = { ...pin, rowMode: undefined, thinkingLevel: "high" };
  const client = createGatewayBrowserClientFixture({
    request: (method) => {
      if (method === "sessions.list") {
        return result;
      }
      if (method === "sessions.subscribe") {
        return { subscribed: true };
      }
      if (method === "sessions.describe") {
        return { session: described };
      }
      if (method === "sessions.groups.list") {
        return { groups: [{ name: "Research" }] };
      }
      if (method === "sessions.groups.defaults") {
        return defaults.promise;
      }
      if (method === "agents.list") {
        return {
          defaultId: "main",
          mainKey: "main",
          scope: "per-sender",
          agents: [{ id: "main", name: "Assistant" }],
        };
      }
      if (method === "models.list") {
        return {
          models: [
            { id: "initial-model", provider: "openai", name: "Initial model" },
            { id: "changed-model", provider: "openai", name: "Changed model" },
          ],
        };
      }
      if (method === "agent.identity.get") {
        return { agentId: "main", name: "Assistant" };
      }
      return {};
    },
  });
  const context = createSessionContext(client);
  const lifetime = new AbortController();
  Object.assign(context, {
    lifecycleAbortSignal: lifetime.signal,
    router: createRouter<RouteId, ApplicationContext>({
      routes: [{ id: "new-session", path: "/new", component: () => ({}) }],
    }),
  });
  context.publishGatewaySnapshot({
    ...context.gateway.snapshot,
    hello: gatewayHelloForMethods([
      "agents.list",
      "agent.identity.get",
      "models.list",
      "sessions.list",
      "sessions.describe",
      "sessions.subscribe",
      "sessions.create",
      "sessions.groups.list",
      "sessions.groups.defaults",
    ]),
  });
  await context.agents.ensureList();
  await context.sessions.refresh({ agentId: "main", force: true });
  const provider = createApplicationContextProvider(context);
  const page = document.createElement("openclaw-new-session-page") as PageHost;
  page.data = routeData("main");
  provider.append(page);
  document.body.append(provider);
  onTestFinished(() => {
    lifetime.abort();
    provider.remove();
    sessionStorage.clear();
    localStorage.clear();
  });
  await waitForSolid(() => expect(page.querySelector("textarea")).not.toBeNull());
  await vi.dynamicImportSettled();
  await waitForSolid(() =>
    expect(page.querySelector("[data-chat-model-select]")?.textContent).toContain("Initial model"),
  );
  const pet = () => page.querySelector<HTMLElement & LobsterPetProps>("openclaw-lobster-pet");
  await waitForSolid(() => expect(pet()).not.toBeNull());
  const describe = async (next: GatewaySessionRow) => {
    described = next;
    const observation = context.sessions.observeRow({ key: next.key, agentId: "main" }, () => {});
    try {
      const reconcile = observation.captureReconcile();
      const response = await context.sessions.describe({ key: next.key }, { refresh: true });
      reconcile(response.session ?? undefined);
      flush();
      await page.updateComplete;
    } finally {
      observation.dispose();
    }
  };
  return { context, page, recent, pin, describe, defaults, pet };
}

it("keeps pin detail enrichment out of composer preparation while live recents update", async () => {
  const { context, page, recent, pin, describe } = await mountSessionDraft();
  const input = page.querySelector<HTMLTextAreaElement>("textarea")!;
  input.value = "Keep this unsent draft";
  input.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true }));
  await page.updateComplete;
  const prepare = vi.spyOn(NewSessionPageOwner.prototype, "composerOptions");
  // This is the production pin path: full-row read, captured reconciliation, and global publication.
  await describe({ ...pin, rowMode: undefined, thinkingLevel: "high" });
  expect(
    context.sessions.state.result?.sessions.find((row) => row.key === pin.key)?.thinkingLevel,
  ).toBe("high");
  expect(prepare).not.toHaveBeenCalled();
  expect(page.querySelector("textarea")).toBe(input);
  expect(input.value).toBe("Keep this unsent draft");

  // Reveal recents again; their independent owner must still publish a real title update.
  input.value = "";
  input.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true }));
  await page.updateComplete;
  prepare.mockClear();
  context.sessions.captureReconcile()({ ...recent, label: "Live research title", updatedAt: 101 });
  await waitForSolid(() =>
    expect(page.querySelector(".agent-chat__recent-name")?.textContent).toBe("Live research title"),
  );
  expect(prepare).not.toHaveBeenCalled();
});

it("keeps default models, group loading, and run presentation live", async () => {
  const { context, page, recent, pin, describe, defaults, pet } = await mountSessionDraft();
  const currentDefaults = context.sessions.state.result!.defaults;
  currentDefaults.model = "changed-model";
  // Preserve the defaults object's identity while a new row receipt publishes the owner.
  await describe({ ...pin, rowMode: undefined, thinkingLevel: "low" });
  await waitForSolid(() =>
    expect(page.querySelector("[data-chat-model-select]")?.textContent).toContain("Changed model"),
  );

  context.sessions.captureReconcile()({
    ...recent,
    hasActiveRun: true,
    status: "running",
    updatedAt: 200,
  });
  await waitForSolid(() => expect(pet()?.mode).toBe("busy"));
  context.sessions.captureReconcile()({
    ...recent,
    hasActiveRun: false,
    status: "failed",
    endedAt: 300,
    updatedAt: 300,
  });
  await waitForSolid(() => expect(pet()).toMatchObject({ mode: "idle", runOutcome: "error" }));

  page.data = { ...routeData("main"), group: "Research", groupStatus: "missing" };
  await page.updateComplete;
  const retry = () =>
    page.querySelector<HTMLButtonElement>(".new-session-page__catalog-unavailable button");
  await waitForSolid(() => expect(retry()?.disabled).toBe(false));
  const loading = context.sessions.groupsLoad();
  await waitForSolid(() => expect(retry()?.disabled).toBe(true));
  defaults.resolve({ defaults: [{ name: "Research" }] });
  await loading;
  await waitForSolid(() => expect(retry()?.disabled).toBe(false));
});
