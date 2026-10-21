/* @vitest-environment jsdom */

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { GatewayRequestError } from "../../api/gateway.ts";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../../app/context.ts";
import { i18n } from "../../i18n/index.ts";
import {
  createApplicationContextProvider,
  createApplicationGateway,
} from "../../test-helpers/application-context.ts";
import {
  createTestGatewayClient,
  type GatewayRequestHandler,
} from "../../test-helpers/gateway-client.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import { questionPanelIn } from "../chat/components/chat-question-card.test-support.ts";
import "./question-page-registration.ts";

const tag = "openclaw-question-page";
type QuestionPage = HTMLElementTagNameMap[typeof tag];
const answers = { answers: { audience: ["The design team"] } };

function question(id = "question-one") {
  return {
    id,
    status: "pending",
    createdAtMs: Date.now(),
    expiresAtMs: Date.now() + 60_000,
    questions: [{ questionId: "audience", header: "To", question: id, options: [], isOther: true }],
  };
}

async function mount(request: GatewayRequestHandler) {
  const harness = createApplicationGateway();
  const { gateway } = harness;
  const update = (patch: Partial<ApplicationGatewaySnapshot>) =>
    harness.publish({ ...gateway.snapshot, ...patch });
  update({ client: createTestGatewayClient(request), phase: "connected" });
  const provider = createApplicationContextProvider({ gateway } as ApplicationContext);
  const page = document.createElement(tag);
  page.questionId = "question-one";
  provider.append(page);
  document.body.append(provider);
  await settle(page);
  return { page, update };
}

async function settle(page: QuestionPage) {
  await Promise.resolve();
  await Promise.resolve();
  await page.updateComplete;
}

function retry(page: QuestionPage) {
  return Array.from(page.querySelectorAll("button")).find(
    (button) => button.textContent?.trim() === "Retry",
  );
}

beforeEach(() => i18n.setLocale("en"));
afterEach(() => document.body.replaceChildren());

it.each(["question", "outside"] as const)(
  "restores focus only from the removed question (%s)",
  async (focusAt) => {
    const request = vi.fn().mockResolvedValue({ question: question() });
    const { page } = await mount(request);
    await questionPanelIn(page);
    const input = page.querySelector("textarea")!;
    const outside = document.body.appendChild(document.createElement("button"));
    const target = focusAt === "question" ? input : outside;
    target.focus();
    expect(document.activeElement).toBe(target);

    page.questionId = "";
    await settle(page);

    await waitForSolid(() => {
      expect(input.isConnected).toBe(false);
      expect(document.activeElement).toBe(
        focusAt === "question" ? page.querySelector("#question-page-title") : outside,
      );
    });
    expect(page.textContent).toContain("Unavailable");
    expect(request).toHaveBeenCalledTimes(1);
  },
);

it("recovers a failed reconnect lookup without losing the typed answer", async () => {
  const request = vi
    .fn()
    .mockResolvedValueOnce({ question: question() })
    .mockRejectedValueOnce(new Error("temporary transport failure"))
    .mockResolvedValueOnce({ question: question() })
    .mockResolvedValueOnce({ status: "answered", answers });
  const { page, update } = await mount(request);
  await questionPanelIn(page);
  const input = page.querySelector("textarea")!;
  input.value = "The design team";
  input.dispatchEvent(new InputEvent("input", { bubbles: true }));

  update({ phase: "reconnecting" });
  update({ phase: "connected" });
  await settle(page);
  expect(retry(page)).toBeDefined();
  expect(page.textContent).toContain("Could not load this question. Try again.");
  retry(page)!.click();
  await settle(page);
  await questionPanelIn(page);
  expect(page.querySelector("textarea")?.value).toBe("The design team");
  page.querySelector<HTMLButtonElement>(".chat-question-panel__advance")!.click();
  await settle(page);
  expect(request).toHaveBeenLastCalledWith(
    "question.resolve",
    { id: "question-one", answers },
    expect.any(Object),
  );
  await waitForSolid(() => expect(page.textContent).toContain("Answered"));
  expect(page.querySelector(".chat-question-summary")?.textContent).toContain("The design team");
});

it.each(["id", "client"] as const)("ignores stale retry rejection (%s)", async (change) => {
  const pending = createDeferred<unknown>();
  const request = vi
    .fn()
    .mockRejectedValueOnce(new Error("temporary lookup failure"))
    .mockReturnValueOnce(pending.promise)
    .mockResolvedValue({ question: question("question-two") });
  const { page, update } = await mount(request);
  expect(retry(page)).toBeDefined();
  retry(page)!.click();
  await settle(page);
  if (change === "id") {
    page.questionId = "question-two";
    await page.updateComplete;
  } else {
    update({
      client: createTestGatewayClient(vi.fn().mockResolvedValue({ question: question() })),
    });
  }
  await settle(page);
  await questionPanelIn(page);
  pending.reject(new Error("old lookup failed"));
  await settle(page);
  expect(page.querySelector("textarea")).not.toBeNull();
  expect(retry(page)).toBeUndefined();
});

it("keeps confirmed missing questions unavailable without a retry", async () => {
  const request = vi.fn().mockRejectedValue(
    new GatewayRequestError({
      code: "INVALID_REQUEST",
      message: "question not found",
      details: { reason: "QUESTION_NOT_FOUND" },
    }),
  );
  const { page } = await mount(request);
  expect(page.textContent).toContain("Unavailable");
  expect(retry(page)).toBeUndefined();
});

it("loads only the final question when native IDs change in one turn", async () => {
  const request = vi
    .fn()
    .mockResolvedValueOnce({ question: question() })
    .mockResolvedValueOnce({ question: question("question-three") });
  const { page } = await mount(request);
  await questionPanelIn(page);

  page.questionId = "question-two";
  page.questionId = "question-three";
  await settle(page);
  await questionPanelIn(page);

  expect(request.mock.calls.map(([, params]) => params)).toEqual([
    { id: "question-one" },
    { id: "question-three" },
  ]);
  expect(page.textContent).toContain("question-three");
});
