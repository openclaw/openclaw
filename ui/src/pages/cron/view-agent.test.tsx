/* @vitest-environment jsdom */
import { afterEach, expect, it } from "vitest";
import type { CronJob } from "../../api/types.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { cleanupSolid } from "../../test-helpers/solid-cleanup.ts";
import { flush, waitForSolid } from "../../test-helpers/solid-settle.ts";
import {
  callsFor,
  click,
  fillInput,
  testId,
  waitForElement,
} from "./cron-assertions.test-support.ts";
import {
  createContext,
  createGateway,
  createPage,
  cronListResponse,
} from "./cron-page.test-support.tsx";
import { cronRpc } from "./cron-rpc.test-support.ts";
import { createCronViewJob } from "./view.test-support.ts";

afterEach(() => {
  cleanupSolid();
  document.body.replaceChildren();
});

async function fixture(rejectCreate = false) {
  let saved: CronJob | undefined;
  const job = createCronViewJob("saved", {
    name: "Digest",
    agentId: "research",
    sessionTarget: "isolated",
    payload: { kind: "agentTurn", message: "Keep this prompt." },
  });
  const request = cronRpc({
    "cron.add": () => {
      if (rejectCreate) {
        throw new Error("Example create failure");
      }
      saved = job;
      return { job: saved };
    },
    "cron.update": () => {
      saved = { ...job, agentId: undefined };
      return saved;
    },
    "cron.list": () => cronListResponse(saved ? [saved] : []),
  });
  const gateway = createGateway(createTestGatewayClient(request), true);
  const context = createContext(gateway);
  context.agents.state.agentsList = {
    defaultId: "main",
    mainKey: "main",
    scope: "per-sender",
    agents: [
      { id: "main", name: "Assistant" },
      { id: "research", identity: { name: "Research" } },
      { id: "research-secondary", name: "Research" },
      { id: "maintenance", kind: "system", name: "Internal maintenance" },
    ],
  };
  const page = createPage(context, { render: true });
  await waitForElement(page, testId("cron-new-task"));
  click(page, testId("cron-new-task"));
  await waitForElement(page, "fieldset.cron-editor");
  fillInput(page, "#cron-name", "Digest");
  fillInput(page, "#cron-payload-text", "Keep this prompt.");
  await page.settle();
  return { page, request, context };
}

async function choose(page: HTMLElement, value: string) {
  click(page, "#cron-agent-id");
  const selector = '[role="option"][data-value="' + value + '"]';
  const option = await waitForElement(page, selector);
  option.click();
  flush();
}

it("chooses a named agent, saves its ID, reloads it, and explicitly clears an edit override", async () => {
  const { page, request } = await fixture();
  await choose(page, "research");
  expect(page.querySelector("#cron-agent-id")?.textContent).toContain("Research");
  expect(page.querySelector("#cron-agent-id")?.textContent).toContain("research");
  expect(callsFor(request, "cron.add")).toHaveLength(0);
  click(page, testId("cron-submit"));
  await waitForSolid(() => expect(callsFor(request, "cron.add")).toHaveLength(1));
  expect(callsFor(request, "cron.add")[0]?.[1]).toMatchObject({
    agentId: "research",
    name: "Digest",
    payload: { kind: "agentTurn", message: "Keep this prompt." },
  });
  await waitForElement(page, testId("cron-row-saved"));
  click(page, testId("cron-row-saved"));
  await waitForSolid(() =>
    expect(page.querySelector("#cron-agent-id")?.textContent).toContain("Research"),
  );
  await choose(page, "");
  expect(page.cron.cronForm).toMatchObject({ agentId: "", clearAgent: true });
  click(page, testId("cron-submit"));
  await waitForSolid(() => expect(callsFor(request, "cron.update")).toHaveLength(1));
  expect(callsFor(request, "cron.update")[0]?.[1]).toMatchObject({
    patch: { agentId: null, name: "Digest" },
  });
});

it("keeps custom and unresolved references through a failed roster refresh without changing the prompt", async () => {
  const { page, context } = await fixture();
  await choose(page, "__custom_agent__");
  const input = await waitForElement<HTMLInputElement>(page, 'input[aria-label="Custom agent ID"]');
  fillInput(page, 'input[aria-label="Custom agent ID"]', "night-shift");
  context.agents.state.agentsList = null;
  context.agents.state.agentsError = "Example discovery failure";
  page.refreshView();
  await page.settle();
  expect(input.value).toBe("night-shift");
  expect(page.cron.cronForm.payloadText).toBe("Keep this prompt.");
  expect(page.textContent).toContain("Couldn’t load available agents.");
  await choose(page, "");
  expect(page.cron.cronForm).toMatchObject({
    agentId: "",
    clearAgent: false,
    payloadText: "Keep this prompt.",
  });
});

it("does not offer internal system agents as new automation targets", async () => {
  const { page } = await fixture();
  click(page, "#cron-agent-id");
  await waitForElement(page, '[role="option"][data-value="research"]');
  expect(page.querySelector('[role="option"][data-value="maintenance"]')).toBeNull();
});

it("retains the custom agent and unrelated draft after a rejected create", async () => {
  const { page, request } = await fixture(true);
  await choose(page, "__custom_agent__");
  await waitForElement(page, 'input[aria-label="Custom agent ID"]');
  fillInput(page, 'input[aria-label="Custom agent ID"]', "night-shift");
  flush();
  click(page, testId("cron-submit"));
  await waitForSolid(() => expect(page.textContent).toContain("Example create failure"));
  expect(callsFor(request, "cron.add")[0]?.[1]).toMatchObject({
    agentId: "night-shift",
    name: "Digest",
  });
  expect(page.cron.cronForm).toMatchObject({
    agentId: "night-shift",
    payloadText: "Keep this prompt.",
  });
  expect(page.querySelector<HTMLInputElement>('input[aria-label="Custom agent ID"]')?.value).toBe(
    "night-shift",
  );
});
