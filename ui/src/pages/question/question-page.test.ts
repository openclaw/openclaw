/* @vitest-environment jsdom */

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { GatewayRequestError } from "../../api/gateway-connect-errors.ts";
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
import "./question-page.tsx";

type QuestionPage = HTMLElementTagNameMap["openclaw-question-page"];
const answers = { answers: { audience: ["The design team"] } };
const reply = (id = "q1") => ({
  question: {
    id,
    status: "pending",
    createdAtMs: Date.now(),
    expiresAtMs: Date.now() + 60_000,
    questions: [{ questionId: "audience", header: "To", question: id, options: [], isOther: true }],
  },
});

async function mount(request: GatewayRequestHandler) {
  const { gateway, publish, publishEvent } = createApplicationGateway();
  const update = (patch: Partial<ApplicationGatewaySnapshot>) =>
    publish({ ...gateway.snapshot, ...patch });
  update({ client: createTestGatewayClient(request), phase: "connected" });
  const provider = createApplicationContextProvider({ gateway } as ApplicationContext);
  const page = document.createElement("openclaw-question-page");
  page.questionId = "q1";
  provider.append(page);
  document.body.append(provider);
  await settle(page);
  return { page, update, publishEvent };
}

async function settle(page: QuestionPage) {
  await Promise.resolve();
  await Promise.resolve();
  await page.updateComplete;
}

const retry = (page: QuestionPage) =>
  page.querySelector<HTMLButtonElement>(".approval-page__state .btn");
const panelButton = (page: QuestionPage, action: string) =>
  page.querySelector<HTMLButtonElement>(`.chat-question-panel__${action}`)!;

beforeEach(() => i18n.setLocale("en"));
afterEach(() => document.body.replaceChildren());

it.each(["question", "outside"] as const)("restores only question focus (%s)", async (focusAt) => {
  const { page } = await mount(vi.fn().mockResolvedValue(reply()));
  await questionPanelIn(page);
  const input = page.querySelector("textarea")!;
  const outside = document.body.appendChild(document.createElement("button"));
  const target = focusAt === "question" ? input : outside;
  target.focus();

  page.questionId = "";
  await settle(page);
  await waitForSolid(() => {
    expect(input.isConnected).toBe(false);
    const next = focusAt === "question" ? page.querySelector("#question-page-title") : outside;
    expect(document.activeElement).toBe(next);
  });
  expect(page.textContent).toContain("Unavailable");
});

it("keeps focus on the collapsed standalone question", async () => {
  const { page } = await mount(vi.fn().mockResolvedValue(reply()));
  await questionPanelIn(page);
  const collapse = panelButton(page, "collapse");
  collapse.focus();
  collapse.click();
  await waitForSolid(() =>
    expect(document.activeElement).toBe(panelButton(page, "collapsed-button")),
  );
});

it("recovers a failed reconnect lookup without losing the typed answer", async () => {
  const get = vi
    .fn()
    .mockResolvedValueOnce(reply())
    .mockRejectedValueOnce(new Error("temporary transport failure"))
    .mockResolvedValue(reply());
  const request = vi.fn((method: string) =>
    method === "question.get"
      ? get()
      : Promise.resolve(
          method === "question.resolve"
            ? { status: "answered", answers }
            : {
                questions: [],
                continuations: [
                  {
                    questionId: "q1",
                    status: "blocked",
                    reason: "Original caller is unavailable.",
                    nextAction: "Start a new user turn.",
                  },
                ],
              },
        ),
  );
  const { page, update } = await mount(request);
  await questionPanelIn(page);
  const input = page.querySelector("textarea")!;
  input.value = "The design team";
  input.dispatchEvent(new InputEvent("input", { bubbles: true }));

  update({ phase: "reconnecting" });
  update({ phase: "connected" });
  await waitForSolid(() => expect(retry(page)?.textContent?.trim()).toBe("Retry"));
  retry(page)!.click();
  await settle(page);
  await questionPanelIn(page);
  expect(page.querySelector("textarea")?.value).toBe("The design team");
  panelButton(page, "advance").click();
  await waitForSolid(() => expect(page.textContent).toContain("Answered"));
  expect(page.querySelector(".chat-question-summary")?.textContent).toContain("The design team");
  await waitForSolid(() =>
    expect(page.textContent).toContain("Original caller is unavailable. Start a new user turn."),
  );
});

it.each(["coalesce", "retry-id", "retry-client"])("retires stale lookup (%s)", async (change) => {
  const retried = change !== "coalesce";
  const id = change === "retry-client" ? "q1" : "q2";
  const pending = createDeferred<unknown>();
  const request = vi.fn();
  if (retried) {
    request.mockRejectedValueOnce(new Error("temporary lookup failure"));
  }
  request.mockReturnValueOnce(pending.promise).mockResolvedValueOnce(reply(id));
  const { page, update } = await mount(request);
  if (retried) {
    await waitForSolid(() => expect(retry(page)?.textContent?.trim()).toBe("Retry"));
    retry(page)!.click();
  }
  await waitForSolid(() => {
    expect(page.querySelector("main")?.getAttribute("aria-busy")).toBe("true");
    expect(retry(page)).toBeNull();
    expect(document.title).toContain("Loading");
  });
  if (change !== "retry-client") {
    if (!retried) {
      page.questionId = "intermediate";
    }
    page.questionId = "q2";
  } else {
    update({ client: createTestGatewayClient(async () => reply(id)) });
  }
  await waitForSolid(() => expect(page.textContent).toContain(id));
  await questionPanelIn(page);
  expect(request).toHaveBeenCalledTimes(change === "retry-id" ? 3 : 2);
  expect(request.mock.calls.map(([, params]) => params)).toEqual(
    change === "retry-id"
      ? [
          { id: "q1", includeContinuation: true },
          { id: "q1", includeContinuation: true },
          { id: "q2", includeContinuation: true },
        ]
      : change === "coalesce"
        ? [
            { id: "q1", includeContinuation: true },
            { id: "q2", includeContinuation: true },
          ]
        : [
            { id: "q1", includeContinuation: true },
            { id: "q1", includeContinuation: true },
          ],
  );
  expect(page.querySelector("main")?.getAttribute("aria-busy")).toBe("false");
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
  await waitForSolid(() => expect(page.textContent).toContain("Unavailable"));
  expect(retry(page)).toBeNull();
});

it("restores an authoritative answer when the retained prompt expires during reconnect", async () => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  const retained = { ...reply().question, expiresAtMs: Date.now() + 5_000 };
  const response = createDeferred<unknown>();
  let reads = 0;
  const request = vi.fn((method: string) =>
    method === "question.get"
      ? ++reads === 1
        ? Promise.resolve({ question: retained })
        : response.promise
      : Promise.resolve({ questions: [] }),
  );
  try {
    const { page, update } = await mount(request);
    await settle(page);
    update({ phase: "reconnecting" });
    update({ phase: "connected" });
    await settle(page);
    vi.advanceTimersByTime(5_000);
    response.resolve({
      question: {
        ...retained,
        status: "answered",
        answers: { answers: { audience: ["The design team"] } },
      },
      continuation: {
        questionId: retained.id,
        status: "blocked",
        reason: "Original caller is unavailable.",
        nextAction: "Start a new user turn.",
      },
    });
    await settle(page);
    await waitForSolid(() => {
      expect(page.textContent).toContain("Answered");
      expect(page.textContent).toContain("The design team");
      expect(page.textContent).toContain("Start a new user turn.");
    });
  } finally {
    vi.useRealTimers();
  }
});

it("keeps newer continuation guidance when an older reconnect read completes", async () => {
  const retained = {
    ...reply().question,
    status: "answered",
    answers: { answers: { audience: ["The design team"] } },
  };
  const reconnect = createDeferred<unknown>();
  let reads = 0;
  let receipts = 0;
  const request = vi.fn((method: string) => {
    if (method === "question.get") {
      return ++reads === 1 ? Promise.resolve({ question: retained }) : reconnect.promise;
    }
    if (++receipts === 1) {
      return Promise.resolve({ questions: [] });
    }
    if (receipts === 2) {
      return Promise.resolve({
        questions: [],
        continuations: [
          {
            questionId: retained.id,
            status: "blocked",
            reason: "Original caller is unavailable.",
            nextAction: "Start a new user turn.",
          },
        ],
      });
    }
    return Promise.reject(new Error("receipt refresh unavailable"));
  });
  const { page, update, publishEvent } = await mount(request);
  await waitForSolid(() => expect(page.textContent).toContain("Answered"));
  await settle(page);
  update({ phase: "reconnecting" });
  update({ phase: "connected" });
  await settle(page);
  expect(reads).toBe(2);
  const resolution = {
    type: "event" as const,
    event: "question.resolved",
    payload: { id: retained.id, status: "answered", answers: retained.answers },
  };
  publishEvent(resolution);
  await waitForSolid(() => expect(receipts).toBe(2));
  await settle(page);
  reconnect.resolve({ question: retained });
  await settle(page);
  publishEvent(resolution);
  await waitForSolid(() => expect(receipts).toBeGreaterThanOrEqual(3));
  await settle(page);
  await waitForSolid(() => {
    expect(page.textContent).toContain("Answered");
    expect(page.textContent).toContain("The design team");
    expect(page.textContent).toContain("Original caller is unavailable. Start a new user turn.");
  });
});
