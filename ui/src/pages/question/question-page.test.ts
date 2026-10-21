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

type QuestionPage = HTMLElementTagNameMap["openclaw-question-page"];
const answers = { answers: { audience: ["The design team"] } };
const question = (id = "q1") => ({
  id,
  status: "pending",
  createdAtMs: Date.now(),
  expiresAtMs: Date.now() + 60_000,
  questions: [{ questionId: "audience", header: "To", question: id, options: [], isOther: true }],
});

async function mount(request: GatewayRequestHandler) {
  const { gateway, publish } = createApplicationGateway();
  const update = (patch: Partial<ApplicationGatewaySnapshot>) =>
    publish({ ...gateway.snapshot, ...patch });
  update({ client: createTestGatewayClient(request), phase: "connected" });
  const provider = createApplicationContextProvider({ gateway } as ApplicationContext);
  const page = document.createElement("openclaw-question-page");
  page.questionId = "q1";
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
  return page.querySelector<HTMLButtonElement>(".approval-page__state .btn");
}

beforeEach(() => i18n.setLocale("en"));
afterEach(() => document.body.replaceChildren());

it.each(["question", "outside"] as const)("restores only question focus (%s)", async (focusAt) => {
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
    const next = focusAt === "question" ? page.querySelector("#question-page-title") : outside;
    expect(document.activeElement).toBe(next);
  });
  expect(page.textContent).toContain("Unavailable");
  expect(request).toHaveBeenCalledTimes(1);
});

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
  expect(retry(page)?.textContent?.trim()).toBe("Retry");
  expect(page.textContent).toContain("Could not load this question. Try again.");
  retry(page)!.click();
  await settle(page);
  await questionPanelIn(page);
  expect(page.querySelector("textarea")?.value).toBe("The design team");
  page.querySelector<HTMLButtonElement>(".chat-question-panel__advance")!.click();
  await settle(page);
  const resolution = { id: "q1", answers };
  expect(request).toHaveBeenLastCalledWith("question.resolve", resolution, expect.any(Object));
  await waitForSolid(() => expect(page.textContent).toContain("Answered"));
  expect(page.querySelector(".chat-question-summary")?.textContent).toContain("The design team");
});

it.each(["id", "client"] as const)("ignores stale retry rejection (%s)", async (change) => {
  const pending = createDeferred<unknown>();
  const request = vi
    .fn()
    .mockRejectedValueOnce(new Error("temporary lookup failure"))
    .mockReturnValueOnce(pending.promise)
    .mockResolvedValue({ question: question("q2") });
  const { page, update } = await mount(request);
  expect(retry(page)?.textContent?.trim()).toBe("Retry");
  retry(page)!.click();
  await settle(page);
  if (change === "id") {
    page.questionId = "q2";
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
  expect(retry(page)).toBeNull();
});

it("keeps confirmed missing questions unavailable without a retry", async () => {
  const error = new GatewayRequestError({
    code: "INVALID_REQUEST",
    message: "question not found",
    details: { reason: "QUESTION_NOT_FOUND" },
  });
  const { page } = await mount(vi.fn().mockRejectedValue(error));
  expect(page.textContent).toContain("Unavailable");
  expect(retry(page)).toBeNull();
});

it("loads only the final question when native IDs change in one turn", async () => {
  const request = vi
    .fn()
    .mockResolvedValueOnce({ question: question() })
    .mockResolvedValueOnce({ question: question("q3") });
  const { page } = await mount(request);
  await questionPanelIn(page);

  page.questionId = "q2";
  page.questionId = "q3";
  await settle(page);
  await questionPanelIn(page);

  expect(request.mock.calls.map(([, params]) => params)).toEqual([{ id: "q1" }, { id: "q3" }]);
  expect(page.textContent).toContain("q3");
});
