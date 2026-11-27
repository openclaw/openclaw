/* @vitest-environment jsdom */
import { createRouter } from "@openclaw/uirouter";
import { assert, describe, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { GatewaySessionRow } from "../../api/types.ts";
import type { RouteId } from "../../app-route-paths.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { loadSettings, patchSettings } from "../../app/settings.ts";
import type { LobsterPetProps } from "../../components/lobster-pet-contract.ts";
import { t } from "../../i18n/index.ts";
import { sessionsResult } from "../../lib/sessions/session-capability.test-support.ts";
import { createApplicationContextProvider } from "../../test-helpers/application-context.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import { flush, waitForSolid } from "../../test-helpers/solid-settle.ts";
import {
  createGatewayBrowserClientFixture,
  createSessionContext,
} from "../chat/chat-application-context.test-support.ts";
import { ComposerDictationSession } from "../chat/composer-dictation-session.ts";
import {
  createClient,
  dictationIo,
  emit,
  sessionResult,
  setupDictationFixtures,
  transcript,
} from "../chat/composer-dictation.test-support.ts";
import { ComposerDictationOwner } from "../chat/composer-dictation.ts";
import { DirectDictationControl } from "../chat/composer-direct-dictation.ts";
import "./new-session-page-entry.ts";
import { createNewSessionRouteData as routeData } from "./location.test-support.ts";
import { NewSessionPageOwner, type PageHost } from "./new-session-page-owner.ts";
import * as targetControls from "./target-controls-view.tsx";

async function mountSessionDraft(
  agents = [{ id: "main", name: "Assistant" }],
  dictationClient?: GatewayBrowserClient,
) {
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
    ...(dictationClient
      ? { addEventListener: dictationClient.addEventListener.bind(dictationClient) }
      : {}),
    request: (method, params, options) => {
      if (
        dictationClient &&
        (method.startsWith("talk.") || method === "sessions.create" || method === "chat.send")
      ) {
        return dictationClient.request(method, params, options);
      }
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
          agents,
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
      ...(dictationClient ? ["talk.catalog", "talk.session.create", "chat.send"] : []),
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
  const describeRow = async (next: GatewaySessionRow) => {
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
  return { context, page, recent, pin, describeRow, defaults, pet };
}

it("retains the welcome agent selector across draft publications and removes it for catalog targets", async () => {
  const renderSelector = vi.spyOn(targetControls, "AgentSelect");
  const { page } = await mountSessionDraft([
    { id: "main", name: "Assistant" },
    { id: "research", name: "Research" },
  ]);
  const selector = () => page.querySelector(".agent-chat__welcome-name openclaw-agent-select");
  await waitForSolid(() => expect(selector()).not.toBeNull());
  expect(renderSelector).toHaveBeenCalledOnce();
  const initial = selector();
  const input = page.querySelector<HTMLTextAreaElement>("textarea")!;
  input.value = "Keep this unsent draft";
  input.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true }));
  await page.updateComplete;
  expect(selector()).toBe(initial);
  expect(renderSelector).toHaveBeenCalledOnce();
  expect(input.value).toBe("Keep this unsent draft");

  page.data = { ...routeData("main"), catalogId: "catalog-agent" };
  await waitForSolid(() => expect(selector()).toBeNull());
  const heading = page.querySelector(".agent-chat__welcome-identity-copy h2");
  expect(heading).not.toBeNull();
  expect(heading?.classList).not.toContain("sr-only");
  page.data = routeData("main");
  await waitForSolid(() => expect(selector()).not.toBeNull());
  expect(selector()).not.toBe(initial);
  expect(renderSelector).toHaveBeenCalledTimes(2);
});

it("keeps pin detail enrichment out of composer preparation while live recents update", async () => {
  const { context, page, recent, pin, describeRow } = await mountSessionDraft();
  const input = page.querySelector<HTMLTextAreaElement>("textarea")!;
  input.value = "Keep this unsent draft";
  input.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true }));
  await page.updateComplete;
  const prepare = vi.spyOn(NewSessionPageOwner.prototype, "composerOptions");
  // This is the production pin path: full-row read, captured reconciliation, and global publication.
  await describeRow({ ...pin, rowMode: undefined, thinkingLevel: "high" });
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
  const { context, page, recent, pin, describeRow, defaults, pet } = await mountSessionDraft();
  const currentDefaults = context.sessions.state.result!.defaults;
  currentDefaults.model = "changed-model";
  // Preserve the defaults object's identity while a new row receipt publishes the owner.
  await describeRow({ ...pin, rowMode: undefined, thinkingLevel: "low" });
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

describe("new session pending dictation review", () => {
  setupDictationFixtures();

  it.each(["insert", "dismiss", "off"])(
    "requires a separate Send after %s without submitting through pending review",
    async (resolution) => {
      const writes: string[] = [];
      const pendingWrite = createDeferred();
      dictationIo.request.mockImplementation(async (method) => {
        if (method === "talk.session.create") {
          return sessionResult();
        }
        if (method === "talk.catalog") {
          return { transcription: { ready: true }, realtime: { ready: true } };
        }
        if (method === "sessions.create" || method === "chat.send") {
          writes.push(method);
          // Observe admission only; this fixture does not invent a created session.
          return pendingWrite.promise;
        }
        return {};
      });
      const previous = loadSettings().dictationRefinement;
      patchSettings({
        dictationRefinement:
          resolution === "off"
            ? undefined
            : { version: 1, mode: "automatic", locale: "en-US", explicitEnabled: false },
      });
      const options = vi.spyOn(NewSessionPageOwner.prototype, "composerOptions");
      const prepare = vi.spyOn(DirectDictationControl.prototype, "prepare");
      const start = vi.spyOn(ComposerDictationSession.prototype, "start");
      const finish = vi.spyOn(ComposerDictationOwner.prototype, "finishActive");
      try {
        const { page } = await mountSessionDraft(undefined, createClient());
        const owner = options.mock.contexts.at(-1);
        assert.instanceOf(owner, NewSessionPageOwner);
        const input = page.querySelector<HTMLTextAreaElement>("textarea")!;
        input.value = "Existing draft";
        input.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true }));
        await waitForSolid(() => expect(owner.composerOptions().canSubmit).toBe(true));
        expect(owner.submission.message).toBe("Existing draft");
        await waitForSolid(() =>
          expect(prepare.mock.results.at(-1)?.value.voice.microphonePicker.dictationStatus).toBe(
            "ready",
          ),
        );
        input.setSelectionRange(input.value.length, input.value.length);
        page.querySelector<HTMLButtonElement>(".chat-send-btn--voice")!.click();
        await vi.dynamicImportSettled();
        expect(start).toHaveBeenCalledOnce();
        await start.mock.results[0]!.value;
        await waitForSolid(() => expect(input.readOnly).toBe(true));
        expect(owner.dictation.dictation?.requiresReview).toBe(resolution !== "off");
        page.querySelector<HTMLButtonElement>(".chat-send-btn--dictating")!.click();
        expect(finish).toHaveBeenCalledOnce();
        const send = () => page.querySelector<HTMLButtonElement>(".new-session-page__start-submit");
        const expectSubmissionBlocked = async () => {
          await waitForSolid(() => expect(send()?.disabled).toBe(true));
          for (const ctrlKey of [false, true]) {
            input.dispatchEvent(
              new KeyboardEvent("keydown", {
                key: "Enter",
                ctrlKey,
                bubbles: true,
                cancelable: true,
              }),
            );
          }
          send()!.click();
          void owner.submit();
          void owner.submit(true);
          await vi.dynamicImportSettled();
          expect(writes).toEqual([]);
        };
        if (resolution !== "off") {
          await expectSubmissionBlocked();
        }
        transcript("dictated words");
        emit({ type: "close", reason: "completed" });
        await finish.mock.results[0]!.value;
        await waitForSolid(() => expect(input.readOnly).toBe(false));
        if (resolution !== "off") {
          expect(owner.dictation.dictation?.review?.canInsert).toBe(true);
          await expectSubmissionBlocked();
          const label = t(
            resolution === "insert"
              ? "chat.dictation.punctuation.insert"
              : "chat.dictation.punctuation.dismiss",
          );
          const button = [...page.querySelectorAll<HTMLButtonElement>("button")].find(
            (candidate) => candidate.textContent?.trim() === label,
          );
          assert.isDefined(button);
          button.click();
        }
        const expected =
          resolution === "dismiss"
            ? "Existing draft"
            : resolution === "off"
              ? "Existing draft dictated words"
              : "Existing draft dictated words.";
        await waitForSolid(() => expect(send()?.disabled).toBe(false));
        expect(input.value).toBe(expected);
        expect(owner.submission.message).toBe(expected);
        expect(writes).toEqual([]);
        send()!.click();
        await waitForSolid(() => expect(writes).toEqual(["sessions.create"]));
      } finally {
        patchSettings({ dictationRefinement: previous });
      }
    },
  );
});
