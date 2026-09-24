/* @vitest-environment jsdom */

import { DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS } from "@openclaw/gateway-client/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { ModelCatalogEntry, ModelCatalogResult } from "../../api/types.ts";
import { loadModelCatalog } from "../../lib/model-catalog-store.ts";
import { identityPreferences } from "./draft-worktree-preferences.test-support.ts";
import { contextWith, renderControl } from "./model-control.test-support.ts";
import { NewSessionModelControl } from "./model-control.ts";
import { loadNewSessionPreference } from "./preferences.ts";

const models = [{ id: "permitted", name: "Permitted model", provider: "fixture", available: true }];
const restricted: ModelCatalogResult = {
  models,
  modelSelectionPolicy: { restricted: true, defaultModel: "fixture/permitted" },
};
const agent = { id: "main", model: { primary: "fixture/forbidden-default" } };
const scope = { agentId: "main", timeoutMs: DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS };

describe("New Session policy presentation", () => {
  it.each([
    { source: "url", policy: restricted.modelSelectionPolicy },
    { source: "preference", policy: restricted.modelSelectionPolicy },
    { source: "url", policy: { restricted: true as const, defaultModel: null } },
    { source: "url", policy: undefined },
  ])("confirms $source model intent with policy $policy", async ({ source, policy }) => {
    const { context, request } = contextWith(models);
    const wire = createDeferred<ModelCatalogResult>();
    request.mockReturnValue(wire.promise);
    const ready = createDeferred();
    const control = new NewSessionModelControl(() => {
      if (
        renderControl(control, context, "main", agent).querySelector(
          '[data-chat-model-option="fixture/permitted"]',
        )
      ) {
        ready.resolve();
      }
    });
    try {
      control.load(context, "main", true, {
        agent,
        ...(source === "url"
          ? { initialModel: "fixture/forbidden" }
          : { preference: { model: "fixture/forbidden" } }),
      });
      expect(control.modelForSubmission()).toBe("");
      const published = loadModelCatalog(context.gateway.snapshot.client!, scope);
      wire.resolve({ models, modelSelectionPolicy: policy });
      await published;
      await ready.promise;
      expect(control.modelForSubmission()).toBe(policy ? "" : "fixture/forbidden");
      const container = renderControl(control, context, "main", agent);
      if (policy) {
        expect(container.textContent).not.toContain("forbidden");
        expect(control.resolveAgentRuntime()).toBeUndefined();
        if (policy.defaultModel === null) {
          expect(control.modelSelectionBlockedReason(agent)).toBe("Choose a model");
        }
      }
      container
        .querySelector<HTMLButtonElement>('[data-chat-model-option="fixture/permitted"]')
        ?.click();
      expect(control.modelSelectionBlockedReason(agent)).toBeUndefined();
    } finally {
      control.reset();
    }
  });

  it.each([
    { event: "config.changed" as const, payload: {}, clearsChoices: true },
    {
      event: "chat.metadata.changed" as const,
      payload: { modelSelectionChanged: true },
      clearsChoices: true,
    },
    { event: "chat.metadata.changed" as const, payload: {}, clearsChoices: false },
  ])(
    "handles $event while replacement fails (clears: $clearsChoices)",
    async ({ event, payload, clearsChoices }) => {
      const { context, request, emitCatalogChanged } = contextWith(models);
      const ready = createDeferred();
      const failed = createDeferred();
      const control = new NewSessionModelControl(() => {
        const container = renderControl(control, context, "main", agent);
        if (container.querySelector('[data-chat-model-option="fixture/permitted"]')) {
          ready.resolve();
        }
        if (container.querySelector('[data-chat-model-catalog-state="error"]')) {
          failed.resolve();
        }
      });
      try {
        control.load(context, "main", true, { agent });
        await loadModelCatalog(context.gateway.snapshot.client!, scope);
        await ready.promise;
        expect(
          renderControl(control, context, "main", agent).querySelector("[data-chat-model-option]"),
        ).not.toBeNull();
        const wire = createDeferred<ModelCatalogResult>();
        request.mockReturnValueOnce(wire.promise);
        emitCatalogChanged(event, payload);
        const container = renderControl(control, context, "main", agent);
        expect(Boolean(container.querySelector("[data-chat-model-option]"))).toBe(!clearsChoices);
        if (clearsChoices) {
          expect(container.textContent).not.toContain("forbidden-default");
          expect(control.modelSelectionBlockedReason(agent)).toBe("Loading models…");
        }
        const published = loadModelCatalog(context.gateway.snapshot.client!, scope);
        wire.reject(new Error("Catalog unavailable"));
        await expect(published).rejects.toThrow("Catalog unavailable");
        await failed.promise;
        expect(
          Boolean(
            renderControl(control, context, "main", agent).querySelector(
              "[data-chat-model-option]",
            ),
          ),
        ).toBe(!clearsChoices);
        expect(control.modelSelectionBlockedReason(agent)).toBe(
          clearsChoices ? "Models unavailable" : undefined,
        );
      } finally {
        control.reset();
      }
    },
  );

  it.each(["policy", "error"] as const)(
    "withholds retained selection and default across a new connection until its first receipt (%s)",
    async (outcome) => {
      const previous = {
        id: "previous",
        name: "Previous model",
        provider: "fixture",
        available: true,
      };
      const first = contextWith([previous]);
      const next = contextWith(models);
      const wire = createDeferred<ModelCatalogResult>();
      next.request.mockReturnValue(wire.promise);
      const initialPublished = createDeferred();
      const nextPublished = createDeferred();
      let nextActive = false;
      const control = new NewSessionModelControl(() => {
        if (!nextActive && control.modelForSubmission() === "fixture/previous") {
          initialPublished.resolve();
        }
        if (
          nextActive &&
          (outcome === "error"
            ? control.modelSelectionBlockedReason(agent) === "Models unavailable"
            : control.modelForSubmission() === "" &&
              control.modelSelectionBlockedReason(agent) === undefined)
        ) {
          nextPublished.resolve();
        }
      });
      try {
        control.load(first.context, "main", true, {
          agent,
          preference: { model: "fixture/previous" },
        });
        await loadModelCatalog(first.context.gateway.snapshot.client!, scope);
        await initialPublished.promise;
        expect(control.modelForSubmission()).toBe("fixture/previous");
        expect(
          renderControl(control, first.context, "main", agent).querySelector(
            '[data-chat-model-option="fixture/previous"]',
          ),
        ).not.toBeNull();

        nextActive = true;
        control.load(next.context, "main", true, { agent });
        const pending = loadModelCatalog(next.context.gateway.snapshot.client!, scope);
        expect(control.modelForSubmission()).toBe("fixture/previous");
        expect(control.modelSelectionBlockedReason(agent)).toBe("Loading models…");
        const waiting = renderControl(control, next.context, "main", agent);
        expect(waiting.textContent).not.toContain("previous");
        expect(waiting.textContent).not.toContain("Previous model");
        expect(waiting.textContent).not.toContain("forbidden-default");
        expect(waiting.querySelector("[data-chat-model-option]")).toBeNull();

        if (outcome === "error") {
          wire.reject(new Error("Catalog unavailable"));
          await expect(pending).rejects.toThrow("Catalog unavailable");
          await nextPublished.promise;
          expect(control.modelSelectionBlockedReason(agent)).toBe("Models unavailable");
          expect(renderControl(control, next.context, "main", agent).textContent).not.toContain(
            "previous",
          );
        } else {
          wire.resolve(restricted);
          await pending;
          await nextPublished.promise;
          expect(control.modelForSubmission()).toBe("");
          expect(control.modelSelectionBlockedReason(agent)).toBeUndefined();
          const confirmed = renderControl(control, next.context, "main", agent);
          expect(
            confirmed.querySelector('[data-chat-model-option="fixture/permitted"]'),
          ).not.toBeNull();
          expect(confirmed.textContent).not.toContain("previous");
        }
      } finally {
        wire.resolve(restricted);
        control.reset();
      }
    },
  );
});

describe("New Session stored model preference policy", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
    sessionStorage.clear();
  });

  it.each([
    { storage: "browser", identified: false },
    { storage: "identity", identified: true },
  ])(
    "preserves saved model preferences across a restricted policy mask ($storage)",
    async ({ identified }) => {
      const saved = {
        model: "fixture/excluded",
        agentRuntime: "openclaw",
        thinkingLevel: "high",
        fastMode: true,
      };
      const { model, ...savedControls } = saved;
      const savedModel: ModelCatalogEntry = {
        id: "excluded",
        provider: "fixture",
        name: "Saved model",
        available: true,
        agentRuntime: { id: "openclaw", source: "model" },
        reasoning: true,
        thinkingLevels: [{ id: "high", label: "High" }],
        supportsFastMode: true,
      };
      let catalog: ModelCatalogResult = { models: [...models, savedModel] };
      const prefs = identityPreferences(identified, async () => catalog);
      const first = prefs.make();
      const drafts = [first];
      const client = first.context.gateway.snapshot.client!;
      const control = first.place.modelControl;
      const browserBytes = () => {
        const entries: Record<string, string | null> = {};
        for (let index = 0; index < localStorage.length; index += 1) {
          const key = localStorage.key(index);
          if (key !== null) {
            entries[key] = localStorage.getItem(key);
          }
        }
        return entries;
      };
      try {
        // This owner promise includes identity hydration and its initial browser mirror.
        await first.gateway.persistPreference("main", "/repo", saved);
        await loadModelCatalog(client, scope);
        control.reset();
        first.place.adoptAgentDefaults();
        expect(control).toMatchObject({ ...savedControls, selected: model });
        const stored = structuredClone(prefs.stored());
        expect(stored).toMatchObject(saved);
        const browser = browserBytes();
        const writes = vi.spyOn(first.gateway, "persistPreference");
        first.request.mockClear();

        catalog = restricted;
        control.invalidate();
        await loadModelCatalog(client, scope);
        first.place.adoptAgentDefaults();
        // Adopt uses the accepted cached receipt; join any real queued writer it started.
        for (const result of writes.mock.results) {
          await result.value;
        }
        expect(control).toMatchObject({
          selected: "",
          agentRuntime: undefined,
          thinkingLevel: "",
          fastMode: undefined,
        });
        expect(prefs.stored()).toEqual(stored);
        expect(browserBytes()).toEqual(browser);
        expect(first.request.mock.calls.filter(([method]) => method === "users.prefs.set")).toEqual(
          [],
        );
        expect(writes).not.toHaveBeenCalled();

        catalog = { ...restricted, models: [...models, savedModel] };
        control.invalidate();
        await loadModelCatalog(client, scope);
        const next = prefs.make(first.context.gateway);
        drafts.push(next);
        expect(next.place.modelControl).toMatchObject({ ...savedControls, selected: model });
        expect(prefs.stored()).toEqual(stored);

        const repairs = vi.spyOn(next.gateway, "persistPreference");
        first.request.mockClear();
        catalog = { models };
        next.place.modelControl.invalidate();
        await loadModelCatalog(client, scope);
        next.place.adoptAgentDefaults();
        for (const result of repairs.mock.results) {
          await result.value;
        }
        if (identified) {
          expect(prefs.stored()).toMatchObject({
            model: "",
            agentRuntime: "",
            thinkingLevel: "",
            fastMode: undefined,
          });
        }
        for (const field of ["model", "agentRuntime", "thinkingLevel", "fastMode"]) {
          if (!identified) {
            expect(prefs.stored()).not.toHaveProperty(field);
          }
          expect(loadNewSessionPreference("ws://gateway.example", "main")).not.toHaveProperty(
            field,
          );
        }
        expect(first.request.mock.calls.some(([method]) => method === "users.prefs.set")).toBe(
          identified,
        );
        expect(repairs).toHaveBeenCalled();
      } finally {
        for (const draft of drafts) {
          draft.place.modelControl.reset();
          draft.gateway.disconnect();
          draft.place.browser.disconnect();
          draft.flow.disconnect();
        }
      }
    },
  );
});
