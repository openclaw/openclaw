import { afterEach, expect, it, vi } from "vitest";
import type { GatewayEventListener } from "../../api/gateway.ts";
import { invalidateChatMetadataStore } from "../../lib/chat/chat-metadata-cache.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { click, fillInput } from "./cron-assertions.test-support.ts";
import {
  createContext,
  createGateway,
  createPage,
  cronListResponse,
  waitForCronPage,
} from "./cron-page.test-support.tsx";
import { cronRpc, emitEvent } from "./cron-rpc.test-support.ts";
import { createCronViewJob } from "./view.test-support.ts";

afterEach(() => {
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it("clears a failed catalog refresh during retry without holding the task draft", async () => {
  const failed = Promise.withResolvers<{ models: { id: string }[] }>();
  const retry = Promise.withResolvers<{ models: { id: string }[] }>();
  let reads = 0;
  const client = createTestGatewayClient(
    cronRpc({
      "models.list": () =>
        ++reads === 1
          ? { models: [{ id: "initial-model" }] }
          : reads === 2
            ? failed.promise
            : retry.promise,
    }),
  );
  const page = createPage(createContext(createGateway(client, true)), { render: true });
  try {
    click(page, '[data-test-id="cron-new-task"]');
    await waitForCronPage(() => expect(page.querySelector("#cron-name")).not.toBeNull());
    await waitForCronPage(() => expect(page.cronModelSuggestions).toEqual(["initial-model"]));
    const name = fillInput(page, "#cron-name", "Retained task draft");
    invalidateChatMetadataStore(client);
    await waitForCronPage(() => expect(reads).toBe(2));
    failed.reject(new Error("Catalog refresh unavailable"));
    await waitForCronPage(() => expect(page.textContent).toContain("Catalog refresh unavailable"));
    expect(name.value).toBe("Retained task draft");

    invalidateChatMetadataStore(client);
    await waitForCronPage(() => expect(reads).toBe(3));
    await waitForCronPage(() =>
      expect(page.textContent).not.toContain("Catalog refresh unavailable"),
    );
    expect(page.querySelector("#cron-name")).toBe(name);
    fillInput(page, "#cron-name", "Draft edited during retry");
    await waitForCronPage(() => expect(page.cron.cronForm.name).toBe("Draft edited during retry"));
    expect(page.cronModelSuggestions).toEqual(["initial-model"]);
    retry.resolve({ models: [{ id: "updated-model" }] });
    await waitForCronPage(() => expect(page.cronModelSuggestions).toEqual(["updated-model"]));
    expect(name.value).toBe("Draft edited during retry");
  } finally {
    failed.resolve({ models: [] });
    retry.resolve({ models: [] });
    page.remove();
  }
});

it("refreshes catalog warnings when the shell invalidates after the page receives an event", async () => {
  let refreshFailed = false;
  const client = createTestGatewayClient(
    cronRpc({
      "models.list": () => ({ models: [{ provider: "fixture", id: "current" }], refreshFailed }),
    }),
  );
  const gateway = createGateway(client, true);
  const listeners = new Set<GatewayEventListener>();
  vi.spyOn(gateway, "subscribeEvents").mockImplementation((listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  });
  const page = createPage(createContext(gateway), { render: true });
  click(page, '[data-test-id="cron-new-task"]');
  await waitForCronPage(() => expect(page.cronModelSuggestions).toEqual(["fixture/current"]));

  refreshFailed = true;
  for (const listener of listeners) {
    listener({ type: "event", event: "chat.metadata.changed", payload: {} });
  }
  invalidateChatMetadataStore(client);
  await waitForCronPage(() =>
    expect(page.textContent).toContain("Couldn’t refresh some models. Open Models to try again."),
  );
});

it("loads the catalogue only for an open editor and retires closed-editor invalidations", async () => {
  const request = cronRpc({ "models.list": () => ({ models: [{ id: "editor-model" }] }) });
  const client = createTestGatewayClient(request);
  const gateway = createGateway(client, true);
  const page = createPage(createContext(gateway), { render: true });
  const modelCalls = () => request.mock.calls.filter(([method]) => method === "models.list");
  try {
    await page.settle();
    expect(modelCalls()).toHaveLength(0);
    emitEvent(gateway, "chat.metadata.changed");
    await page.settle();
    expect(modelCalls()).toHaveLength(0);
    click(page, '[data-test-id="cron-new-task"]');
    await waitForCronPage(() => expect(page.cronModelSuggestions).toEqual(["editor-model"]));
    expect(modelCalls()).toHaveLength(1);
    page.closePanel();
    await page.settle();
    emitEvent(gateway, "chat.metadata.changed");
    await page.settle();
    expect(modelCalls()).toHaveLength(1);
    click(page, '[data-test-id="cron-new-task"]');
    await waitForCronPage(() => expect(modelCalls()).toHaveLength(2));
    await waitForCronPage(() => expect(page.cronModelSuggestions).toEqual(["editor-model"]));
  } finally {
    page.remove();
  }
});

it("offers the edited task's models instead of the page agent's catalog", async () => {
  const job = createCronViewJob("writer-task", {
    agentId: "writer",
    payload: { kind: "agentTurn", message: "Draft the report", model: "custom/saved" },
  });
  const request = cronRpc({
    "cron.list": () =>
      cronListResponse([
        job,
        createCronViewJob("other-agent-task", {
          agentId: "main",
          payload: { kind: "agentTurn", message: "Other task", model: "fixture/unrelated-job" },
        }),
      ]),
    "cron.update": () => ({ ...job, payload: { ...job.payload, model: "fixture/writer-model" } }),
    "models.list": (params) => ({
      models: [
        {
          provider: "fixture",
          thinkingLevels: [
            { id: "low", label: "Low" },
            { id: "xhigh", label: "Extra high" },
          ],
          id:
            (params as { agentId?: string }).agentId === "writer"
              ? "writer-model"
              : "page-agent-model",
        },
      ],
    }),
  });
  const page = createPage(
    createContext(createGateway(createTestGatewayClient(request), true), null, "main"),
    { render: true },
  );
  try {
    await waitForCronPage(() =>
      expect(page.querySelector('[data-test-id="cron-row-writer-task"]')).not.toBeNull(),
    );
    click(page, '[data-test-id="cron-row-writer-task"]');
    await waitForCronPage(() =>
      expect(page.cronModelSuggestions).toEqual(["fixture/writer-model"]),
    );
    expect(page.cron.cronForm.payloadModel).toBe("custom/saved");
    expect(request).toHaveBeenCalledWith("models.list", { agentId: "writer", view: "configured" });
    fillInput(page, "#cron-agent-id", "");
    await page.settle();
    expect(page.cronModelSuggestions).toEqual(["fixture/writer-model"]);
    fillInput(page, "#cron-agent-id", "writer");
    const picker = page.querySelector<HTMLButtonElement>("#cron-payload-model-picker")!;
    picker.click();
    await waitForCronPage(() =>
      expect(
        page.querySelector('[role="option"][data-value="fixture/writer-model"]'),
      ).not.toBeNull(),
    );
    expect(page.querySelector('[role="option"][data-value="fixture/unrelated-job"]')).toBeNull();
    page.querySelector<HTMLElement>('[role="option"][data-value="fixture/writer-model"]')!.click();
    await page.settle();
    const thinking = page.querySelector<HTMLButtonElement>("#cron-payload-thinking")!;
    expect(thinking.tagName).toBe("BUTTON");
    thinking.click();
    await waitForCronPage(() =>
      expect(page.querySelector('[role="option"][data-value="xhigh"]')).not.toBeNull(),
    );
    page.querySelector<HTMLElement>('[role="option"][data-value="xhigh"]')!.click();
    await page.settle();
    click(page, '[data-test-id="cron-submit"]');
    await waitForCronPage(() =>
      expect(request).toHaveBeenCalledWith(
        "cron.update",
        expect.objectContaining({
          id: job.id,
          patch: expect.objectContaining({
            agentId: "writer",
            payload: expect.objectContaining({ model: "fixture/writer-model", thinking: "xhigh" }),
          }),
        }),
      ),
    );
  } finally {
    page.remove();
  }
});

it("uses a scoped session or the Gateway default when the draft clears its agent", async () => {
  const request = cronRpc({
    "models.list": (params) => ({
      models: [{ id: (params as { agentId?: string }).agentId ?? "gateway-default" }],
    }),
  });
  const page = createPage(createContext(createGateway(createTestGatewayClient(request), true)), {
    render: true,
  });
  try {
    click(page, '[data-test-id="cron-new-task"]');
    await waitForCronPage(() => expect(page.cronModelSuggestions).toEqual(["main"]));
    fillInput(page, "#cron-agent-id", "");
    await waitForCronPage(() => expect(page.cronModelSuggestions).toEqual(["gateway-default"]));
    expect(request).toHaveBeenCalledWith("models.list", { view: "configured" });
    page.patchForm({ sessionKey: "agent:writer:main" });
    await waitForCronPage(() => expect(page.cronModelSuggestions).toEqual(["writer"]));
    expect(request).toHaveBeenCalledWith("models.list", { view: "configured", agentId: "writer" });
    page.patchForm({ agentId: "main", clearAgent: true });
    await page.settle();
    expect(page.cronModelSuggestions).toEqual(["writer"]);
    page.patchForm({ sessionKey: "" });
    await waitForCronPage(() => expect(page.cronModelSuggestions).toEqual(["gateway-default"]));
  } finally {
    page.remove();
  }
});
