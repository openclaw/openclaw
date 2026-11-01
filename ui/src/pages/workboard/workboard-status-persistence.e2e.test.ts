import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import type { WorkboardCard } from "@openclaw/workboard-contract";
import type { Browser, Locator, Page } from "playwright";
import { expect, it, onTestFinished } from "vitest";
import { WORKBOARD_STATUSES as statuses } from "../../../../packages/workboard-contract/src/index.js";
import { createRequireRecord } from "../../../../test/helpers/record.js";
import {
  createControlUiE2eContextOptions,
  createControlUiE2eSuite,
} from "../../e2e/control-ui-e2e-suite.test-support.ts";
import {
  installMockGateway,
  type MockGatewayControls,
  type MockGatewayRequest,
} from "../../test-helpers/control-ui-e2e.ts";
import { workboardUi } from "../../test-helpers/control-ui-workboard-fixture.ts";
import { button, createWorkboardProof, makeCard, moved } from "./workboard.e2e.test-support.ts";

const captureUiProofEnabled = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
const artifactParent = path.resolve(".artifacts/control-ui-e2e/workboard-status-persistence");

const suite = createControlUiE2eSuite({
  name: "Control UI Workboard status persistence E2E",
  startServerBeforeBrowser: true,
});

const linkedSessionKey = "agent:main:workboard-linked-session";
const manualTodoAt = 2_000;
const editedAt = 2_500;
const draggedRunningAt = 3_000;
const staleCompletedSessionAt = 1_000;

function runningCard(id: string, title: string, position: number): WorkboardCard {
  return makeCard({ id, title, position, status: "running", createdAt: 900 }, manualTodoAt);
}

function sessionList(label: string, status: "running" | "done", updatedAt: number) {
  const model = { model: "gpt-5.5", modelProvider: "openai", contextTokens: null };
  return {
    count: 1,
    defaults: model,
    path: "",
    ts: Date.now(),
    sessions: [
      {
        ...model,
        displayName: label,
        label,
        status,
        updatedAt,
        hasActiveRun: status === "running",
        key: linkedSessionKey,
        kind: "direct",
        totalTokens: 0,
      },
    ],
  };
}

function configSnapshot(hash: string) {
  return { config: { plugins: { entries: { workboard: { enabled: true } } } }, hash };
}

async function newPage(options?: Parameters<Browser["newContext"]>[0]) {
  const context = await suite.browser.newContext({
    ...createControlUiE2eContextOptions(),
    ...options,
  });
  onTestFinished(() => context.close());
  return context.newPage();
}

const manualTodoEvents = [moved("event-manual-todo", manualTodoAt, "running", "todo")];
const initialCard = makeCard(
  {
    id: "card-1",
    title: "Persist queue status",
    notes: "Original notes",
    labels: ["ui"],
    agentId: "main",
    createdAt: 900,
    sessionKey: linkedSessionKey,
    events: manualTodoEvents,
  },
  manualTodoAt,
);

const productRunningCard = {
  ...runningCard("product-running-card", "Product board running card", 9_000),
  metadata: { automation: { boardId: "product" } },
} satisfies WorkboardCard;

const archivedDefaultRunningCard = {
  ...runningCard("archived-default-running-card", "Archived default board running card", 3_000),
  metadata: { archivedAt: 1_000 },
} satisfies WorkboardCard;

const editPatch = {
  title: "Persisted renamed card",
  notes: "Edited notes survive reopening.",
  priority: "high",
} satisfies Partial<WorkboardCard>;
const editedCard = {
  ...initialCard,
  ...editPatch,
  updatedAt: editedAt,
  events: [...manualTodoEvents, { id: "event-edited", kind: "edited", at: editedAt }],
} satisfies WorkboardCard;

const draggedRunningCard = {
  ...editedCard,
  status: "running",
  position: 6_000,
  updatedAt: draggedRunningAt,
  events: [
    ...editedCard.events,
    moved("event-manual-running", draggedRunningAt, "todo", "running"),
  ],
} satisfies WorkboardCard;

const staleReviewCard = {
  ...draggedRunningCard,
  status: "review",
  updatedAt: draggedRunningAt + 500,
  events: [
    ...draggedRunningCard.events,
    moved("event-stale-review", draggedRunningAt + 500, "running", "review"),
  ],
} satisfies WorkboardCard;

const requireRecord = createRequireRecord("record", "expected-object-value");

function requestParams(request: MockGatewayRequest): Record<string, unknown> {
  return requireRecord(request.params);
}

function workboardColumn(page: Page, title: string) {
  return page.locator(".workboard-column", {
    has: page.getByRole("heading", { name: title }),
  });
}

function workboardCard(page: Page, columnTitle: string, title: string) {
  return workboardColumn(page, columnTitle).locator(".workboard-card", { hasText: title });
}

async function openCardEditor(card: Locator): Promise<void> {
  await card.hover();
  await button(card, "Card actions").click();
  await button(
    card.page().getByRole("dialog", { name: "Card actions", exact: true }),
    "Edit card",
  ).click();
}

async function dispatchHtml5Drag(source: Locator, target: Locator): Promise<void> {
  const sourceHandle = await source.elementHandle();
  const targetHandle = await target.elementHandle();
  if (!sourceHandle || !targetHandle) {
    throw new Error("Could not resolve Workboard drag source or target");
  }
  try {
    await sourceHandle.evaluate((sourceElement, targetElement) => {
      const dataTransfer = new DataTransfer();
      const targetRect = targetElement.getBoundingClientRect();
      const init = {
        bubbles: true,
        cancelable: true,
        dataTransfer,
        clientX: targetRect.x + targetRect.width / 2,
        clientY: targetRect.top + 1,
      };
      sourceElement.dispatchEvent(new DragEvent("dragstart", init));
      targetElement.dispatchEvent(new DragEvent("dragover", init));
      targetElement.dispatchEvent(new DragEvent("drop", init));
      sourceElement.dispatchEvent(new DragEvent("dragend", init));
    }, targetHandle);
  } finally {
    await sourceHandle.dispose();
    await targetHandle.dispose();
  }
}

async function waitForRequestCount(
  gateway: MockGatewayControls,
  method: string,
  count: number,
): Promise<MockGatewayRequest[]> {
  const deadline = Date.now() + 10_000;
  let stableSince: number | null = null;
  let latest: MockGatewayRequest[] = [];
  while (Date.now() < deadline) {
    latest = await gateway.getRequests(method);
    if (latest.length === count) {
      stableSince ??= Date.now();
      if (Date.now() - stableSince >= 250) {
        return latest;
      }
    } else {
      stableSince = null;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });
  }
  throw new Error(
    `Timed out waiting for exactly ${count} ${method} requests: ${JSON.stringify(latest)}`,
  );
}

suite.define(() => {
  it("preserves an execution-owned session when editing a linked Workboard card", async () => {
    const executionLinkedCard: WorkboardCard = {
      ...initialCard,
      title: "Keep my execution-linked session",
      status: "running",
      execution: {
        id: "execution-linked-card-1",
        kind: "agent-session",
        engine: "codex",
        mode: "autonomous",
        status: "running",
        model: "openai/gpt-5.5",
        sessionKey: linkedSessionKey,
        startedAt: 900,
        updatedAt: manualTodoAt,
      },
    };
    delete executionLinkedCard.sessionKey;
    const updatedCard: WorkboardCard = {
      ...executionLinkedCard,
      title: "Renamed without unlinking the execution",
      updatedAt: editedAt,
    };
    const page = await newPage();
    const gateway = await installMockGateway(page, {
      ...workboardUi,
      methodResponses: {
        "config.get": configSnapshot("execution-linked-workboard-e2e-config"),
        "sessions.list": sessionList("Execution linked session", "running", manualTodoAt),
        "workboard.cards.list": {
          cards: [executionLinkedCard],
          statuses,
        },
        "workboard.cards.update": { card: updatedCard },
      },
    });

    const response = await page.goto(`${suite.server.baseUrl}workboard`);
    expect(response?.status()).toBe(200);
    const executionCard = page.locator(".workboard-card", {
      hasText: executionLinkedCard.title,
    });
    await executionCard.waitFor({ timeout: 10_000 });

    await openCardEditor(executionCard);
    const editDialog = page.getByRole("dialog", { name: "Edit card" });
    await editDialog.waitFor({ timeout: 10_000 });
    const draft = page.locator(".workboard-card-draft");
    await expect
      .poll(() =>
        draft
          .getByRole("button", { name: "Session: Execution linked session", exact: true })
          .isVisible(),
      )
      .toBe(true);

    await page.getByLabel("Title").fill(updatedCard.title);
    await page.getByRole("button", { name: "Save" }).click();

    const requests = await waitForRequestCount(gateway, "workboard.cards.update", 1);
    expect(requestParams(expectDefined(requests[0], "execution-linked card update"))).toEqual({
      id: executionLinkedCard.id,
      expectedUpdatedAt: executionLinkedCard.updatedAt,
      patch: { title: updatedCard.title },
    });
    await editDialog.waitFor({ state: "detached", timeout: 10_000 });
    await page.locator(".workboard-card", { hasText: updatedCard.title }).waitFor({
      timeout: 10_000,
    });
  });

  it("persists edit/reopen fields and does not bounce a dragged linked card from stale lifecycle", async () => {
    const proof = createWorkboardProof("workboard-status-persistence", { parent: artifactParent });
    const page = await newPage({
      recordVideo: captureUiProofEnabled
        ? { dir: proof.directory, size: { height: 900, width: 1280 } }
        : undefined,
    });
    const gateway = await installMockGateway(page, {
      ...workboardUi,
      methodResponses: {
        "config.get": configSnapshot("workboard-e2e-config"),
        "sessions.list": sessionList("Completed linked session", "done", staleCompletedSessionAt),
        "workboard.cards.list": {
          cards: [initialCard, productRunningCard, archivedDefaultRunningCard],
          statuses,
        },
        "workboard.cards.move": {
          card: draggedRunningCard,
        },
        "workboard.cards.update": {
          cases: [
            {
              match: {
                id: "card-1",
                expectedUpdatedAt: initialCard.updatedAt,
                patch: editPatch,
              },
              response: { card: editedCard },
            },
            {
              match: {
                id: "card-1",
                patch: { status: "review" },
              },
              response: { card: staleReviewCard },
            },
          ],
        },
      },
    });

    const response = await page.goto(`${suite.server.baseUrl}workboard`);
    expect(response?.status()).toBe(200);
    await workboardCard(page, "Todo", "Persist queue status").waitFor({ timeout: 10_000 });
    await workboardCard(page, "Running", productRunningCard.title).waitFor({
      timeout: 10_000,
    });
    await expect.poll(() => page.getByText(archivedDefaultRunningCard.title).count()).toBe(0);
    await waitForRequestCount(gateway, "workboard.cards.update", 0);

    await openCardEditor(workboardCard(page, "Todo", "Persist queue status"));
    const editDialog = page.getByRole("dialog", { name: "Edit card" });
    await editDialog.waitFor({ timeout: 10_000 });
    await page.getByLabel("Title").fill(editPatch.title);
    await page.getByLabel("Notes").fill(editPatch.notes);
    const highPriority = page
      .locator(".workboard-card-draft")
      .getByRole("radio", { name: "High", exact: true });
    await highPriority.focus();
    await page.keyboard.press("Space");
    await page.getByRole("button", { name: "Save" }).click();

    const updateRequests = await waitForRequestCount(gateway, "workboard.cards.update", 1);
    expect(requestParams(expectDefined(updateRequests[0], "workboard update request"))).toEqual({
      id: "card-1",
      expectedUpdatedAt: initialCard.updatedAt,
      patch: editPatch,
    });
    try {
      await editDialog.waitFor({ state: "detached", timeout: 10_000 });
    } catch (err) {
      const requests = await gateway.getRequests("workboard.cards.update");
      throw new Error(
        `Edit dialog stayed open after save. Update requests: ${JSON.stringify(requests)}`,
        { cause: err },
      );
    }
    await workboardCard(page, "Todo", "Persisted renamed card").waitFor({ timeout: 10_000 });

    await openCardEditor(workboardCard(page, "Todo", "Persisted renamed card"));
    await editDialog.waitFor({ timeout: 10_000 });
    await expect
      .poll(async () => ({
        title: await page.getByLabel("Title").inputValue(),
        notes: await page.getByLabel("Notes").inputValue(),
        high: await highPriority.isChecked(),
      }))
      .toEqual({ title: editPatch.title, notes: editPatch.notes, high: true });
    await proof.capture(page, "workboard-edit-reopen", editDialog, [
      page.getByLabel("Title"),
      page.getByLabel("Notes"),
    ]);
    await page
      .locator(".workboard-draft > .workboard-modal__actions")
      .last()
      .getByRole("button", { name: "Cancel" })
      .click();
    await editDialog.waitFor({ state: "detached", timeout: 10_000 });

    await dispatchHtml5Drag(
      workboardCard(page, "Todo", "Persisted renamed card"),
      workboardCard(page, "Running", productRunningCard.title),
    );
    const moveRequest = await gateway.waitForRequest("workboard.cards.move");
    const move = requestParams(moveRequest);
    expect(move).toMatchObject({
      id: "card-1",
      status: "running",
    });
    expect(move.position).toBeGreaterThan(archivedDefaultRunningCard.position);
    expect(move.position).toBeLessThan(productRunningCard.position);
    await workboardCard(page, "Running", "Persisted renamed card").waitFor({
      timeout: 10_000,
    });
    await expect
      .poll(() =>
        workboardColumn(page, "Running")
          .locator(".workboard-card")
          .getByRole("heading")
          .allTextContents(),
      )
      .toEqual([editedCard.title, productRunningCard.title]);
    await waitForRequestCount(gateway, "workboard.cards.update", 1);
    await proof.capture(page, "workboard-drag-running-persisted", page.locator(".shell"), [
      workboardCard(page, "Running", "Persisted renamed card"),
    ]);
  });
});
