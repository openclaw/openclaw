import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { createAgentSelectionCapability } from "../../app/agent-selection.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import {
  createContext,
  createGateway,
  createPage,
  createRequest,
  operatorHello,
  waitForCronPage,
} from "./cron-page.test-support.ts";
import "./cron-page.ts";

const cleanups: (() => void)[] = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) {
    cleanup();
  }
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

function creationContext(gateway: ReturnType<typeof createGateway>) {
  const base = createContext(gateway);
  base.agents.state.agentsList = {
    defaultId: "main",
    mainKey: "main",
    scope: "per-sender",
    agents: [{ id: "main" }, { id: "writer" }],
  };
  const agentSelection = createAgentSelectionCapability(gateway, base.agents);
  const lifecycle = new AbortController();
  cleanups.push(() => {
    lifecycle.abort();
    agentSelection.dispose();
  });
  return {
    context: { ...base, agentSelection, lifecycleAbortSignal: lifecycle.signal },
    lifecycle,
  };
}

function button(page: HTMLElement, id: string) {
  const element = page.querySelector<HTMLButtonElement>(`[data-test-id="${id}"]`);
  expect(element).not.toBeNull();
  return element!;
}

async function fillDraft(page: ReturnType<typeof createPage>, name = "Unsaved automation") {
  button(page, "cron-new-task").click();
  await page.updateComplete;
  for (const [id, value] of [
    ["cron-name", name],
    ["cron-payload-text", "Synthetic prompt"],
  ] as const) {
    const input = page.querySelector<HTMLInputElement | HTMLTextAreaElement>(`#${id}`)!;
    input.value = value;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await page.updateComplete;
  }
}

describe("CronPage creation lifetime", () => {
  it("restores a failed pending creation after remount without dispatching twice", async () => {
    const add = createDeferred<{ id: string }>();
    const fallback = createRequest();
    const request = vi.fn((method: string) =>
      method === "cron.add" ? add.promise : fallback(method),
    );
    const { context } = creationContext(createGateway(createTestGatewayClient(request), true));
    const first = createPage(context, { render: true });
    await first.updateComplete;
    await fillDraft(first);
    button(first, "cron-submit").click();
    await first.updateComplete;
    expect(request.mock.calls.filter(([method]) => method === "cron.add")).toHaveLength(1);
    first.remove();
    const second = createPage(context, { render: true });
    await second.updateComplete;
    expect(second.querySelector<HTMLInputElement>("#cron-name")?.value).toBe("Unsaved automation");
    expect(button(second, "cron-submit").disabled).toBe(true);
    // A queued event must be rejected by dispatch ownership as well as by the control.
    button(second, "cron-submit").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(request.mock.calls.filter(([method]) => method === "cron.add")).toHaveLength(1);
    add.reject(new Error("Synthetic creation failed"));
    await waitForCronPage(() => expect(second.textContent).toContain("Synthetic creation failed"));
    expect(button(second, "cron-submit").disabled).toBe(false);
    expect(second.querySelector<HTMLInputElement>("#cron-name")?.value).toBe("Unsaved automation");
  });

  it.each(["agent", "filter", "gateway", "permission", "application"])(
    "retires an unmounted draft after %s changes, including a return to the old scope",
    async (change) => {
      const gateway = createGateway(createTestGatewayClient(createRequest()), true);
      const { context, lifecycle } = creationContext(gateway);
      const first = createPage(context, { render: true });
      await first.updateComplete;
      await fillDraft(first);
      first.remove();
      if (change === "agent") {
        context.agentSelection.set("writer");
        context.agentSelection.set("main");
      } else if (change === "filter") {
        context.agentSelection.setScope(null);
        context.agentSelection.setScope("main");
      } else if (change === "gateway") {
        Object.defineProperty(gateway, "connectionRevision", { configurable: true, value: 1 });
        gateway.emitSnapshot({ phase: "reconnecting" });
        Object.defineProperty(gateway, "connectionRevision", { configurable: true, value: 2 });
        gateway.emitSnapshot({ phase: "connected" });
      } else if (change === "permission") {
        gateway.emitSnapshot({ hello: operatorHello(["operator.read"]) });
        gateway.emitSnapshot({ hello: operatorHello(["operator.admin"]) });
      } else {
        lifecycle.abort();
      }
      const second = createPage(context, { render: true });
      await second.updateComplete;
      expect(second.querySelector("#cron-name")).toBeNull();
      if (change !== "application") {
        await fillDraft(second, "Replacement draft");
        expect(second.querySelector<HTMLInputElement>("#cron-name")?.value).toBe(
          "Replacement draft",
        );
      }
    },
  );

  it.each([
    { outcome: "success", change: "scope" },
    { outcome: "failure", change: "scope" },
    { outcome: "success", change: "discard" },
    { outcome: "failure", change: "discard" },
  ])(
    "keeps a newer draft after $change when the old add ends in $outcome",
    async ({ outcome, change }) => {
      const add = createDeferred<{ id: string }>();
      const fallback = createRequest();
      const request = vi.fn((method: string) =>
        method === "cron.add" ? add.promise : fallback(method),
      );
      const { context } = creationContext(createGateway(createTestGatewayClient(request), true));
      const first = createPage(context, { render: true });
      await first.updateComplete;
      await fillDraft(first);
      button(first, "cron-submit").click();
      await first.updateComplete;
      let second = first;
      if (change === "scope") {
        first.remove();
        context.agentSelection.set("writer");
        context.agentSelection.set("main");
        second = createPage(context, { render: true });
      } else {
        // A previously queued discard callback can arrive after submit admission.
        button(first, "cron-back").dispatchEvent(new MouseEvent("click", { bubbles: true }));
      }
      await second.updateComplete;
      await fillDraft(second, "New generation");
      if (outcome === "success") {
        add.resolve({ id: "accepted-old-job" });
      } else {
        add.reject(new Error("Old creation failed"));
      }
      await Promise.allSettled([add.promise]);
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
      });
      await second.updateComplete;
      expect(second.querySelector<HTMLInputElement>("#cron-name")?.value).toBe("New generation");
      expect(second.textContent).not.toContain("Old creation failed");
      expect(button(second, "cron-submit").disabled).toBe(false);
      expect(request.mock.calls.filter(([method]) => method === "cron.add")).toHaveLength(1);
    },
  );
});
