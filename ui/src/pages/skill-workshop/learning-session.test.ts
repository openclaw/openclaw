/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferredCore } from "../../../../src/shared/deferred.js";
import type { SessionCreateOutcome } from "../../lib/sessions/create.ts";
import { createSkillWorkshopState, skillWorkshopRouteData } from "./proposals.ts";
import {
  createContext,
  type SkillWorkshopPageTestElement,
} from "./skill-workshop-page.test-support.ts";
import "./skill-workshop-page.ts";

afterEach(() => document.body.replaceChildren());

async function mountLearningPage() {
  const state = createSkillWorkshopState();
  state.skillWorkshopAgentId = "research";
  state.skillWorkshopLoaded = true;
  const context = createContext(vi.fn(), { methods: ["sessions.create"] });
  const page = document.createElement(
    "openclaw-skill-workshop-page",
  ) as SkillWorkshopPageTestElement;
  page.data = skillWorkshopRouteData(state);
  page.context = context;
  document.body.append(page);
  await page.updateComplete;
  const button = Array.from(page.querySelectorAll("button")).find(
    (entry) => entry.textContent?.trim() === "Learn from past conversations",
  );
  expect(button).toBeDefined();
  return { page, context, button: button! };
}

describe("Workshop learning session", () => {
  it("starts one ordinary session and opens its acknowledged run", async () => {
    const { context, button } = await mountLearningPage();
    const creation = createDeferredCore<SessionCreateOutcome | null>();
    context.sessions.createResult = vi.fn(() => creation.promise);
    button.click();
    button.click();

    expect(context.sessions.createResult).toHaveBeenCalledExactlyOnceWith(
      {
        agentId: "research",
        displayName: "Learn from past conversations",
        message: expect.stringContaining("past conversations"),
        idempotencyKey: expect.any(String),
      },
      { reconciliation: "background" },
    );
    expect(context.navigate).not.toHaveBeenCalled();
    const key = "agent:research:dashboard:7e93881c-0186-4d25-9e99-cdce85cac675";
    creation.resolve({ key, initialRun: { status: "started", runId: "learning-run" } });
    await vi.waitFor(() => expect(context.navigate).toHaveBeenCalledOnce());
    expect(context.navigate).toHaveBeenCalledWith("chat", expect.any(Object));
    expect(context.chatSubmissions.retain).toHaveBeenCalledWith(
      expect.objectContaining({ sessionKey: key, pendingRunId: "learning-run" }),
    );
  });

  it("shows a failed creation without automatically retrying", async () => {
    const { page, context, button } = await mountLearningPage();
    context.sessions.state.error = "The Gateway refused this session.";
    context.sessions.createResult = vi.fn(async () => null);
    button.click();
    await vi.waitFor(() =>
      expect(page.querySelector('[role="alert"]')?.textContent).toContain("Gateway refused"),
    );
    expect(context.sessions.createResult).toHaveBeenCalledOnce();
    expect(context.navigate).not.toHaveBeenCalled();
  });

  it("retains an accepted run without redirecting a replaced Workshop page", async () => {
    const { page, context, button } = await mountLearningPage();
    const creation = createDeferredCore<SessionCreateOutcome | null>();
    context.sessions.createResult = vi.fn(() => creation.promise);
    button.click();
    page.remove();
    creation.resolve({
      key: "agent:research:dashboard:7e93881c-0186-4d25-9e99-cdce85cac675",
      initialRun: { status: "started", runId: "learning-run" },
    });
    await creation.promise;
    expect(context.navigate).not.toHaveBeenCalled();
    expect(context.sessions.createResult).toHaveBeenCalledOnce();
    expect(context.chatSubmissions.retain).toHaveBeenCalledWith(
      expect.objectContaining({ pendingRunId: "learning-run" }),
    );
  });
});
