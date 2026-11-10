/* @vitest-environment jsdom */
import { createComponent } from "solid-js";
import { afterEach, beforeEach, expect, it, onTestFinished } from "vitest";
import { createDeferredCore } from "../../../../src/shared/deferred.js";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import { takeCreatedComposer } from "../new-session/creation-composer-registry.ts";
import { CreationComposer as CreationComposerView } from "../new-session/creation-composer-render.tsx";
import {
  cleanupAgentsHomePageTest,
  createPage,
  setupAgentsHomePageTest,
  workflowOperator,
} from "./agents-home-page.test-helpers.ts";
import { addTemplateAgent } from "./templates-add-agent.ts";
import { readTemplateAddReviewPlan } from "./templates-catalog-client.ts";
beforeEach(setupAgentsHomePageTest);
afterEach(cleanupAgentsHomePageTest);

it.each(["ready", "initialization-failed"] as const)(
  "retains buffered input after durable admission until initialization: %s",
  async (outcome) => {
    const { request, context, replace, publishEvent } = createPage({
      templatesEnabled: true,
    });
    const source = {
      packageName: workflowOperator.packageName,
      version: workflowOperator.latestVersion,
    };
    const plan = await readTemplateAddReviewPlan(context.gateway.snapshot.client!, source);
    const original = request.getMockImplementation()!;
    const apply = createDeferredCore<unknown>();
    request.mockImplementation((method, params, options) => {
      if (method === "templates.add.apply") {
        options?.onSent?.("durable-add");
        return apply.promise;
      }
      return original(method, params, options);
    });
    const applying = addTemplateAgent(context, source, plan, false);
    const composer = context.chatSubmissions.readCreate()!.composer!;
    composer.setMessage("Buffered follow-up");
    expect(composer.enqueue()).toBe(true);
    composer.setMessage("Still editing");
    const saved = {
      requestId: "durable-add",
      agentId: "workflow-operator",
      sessionKey: "agent:workflow-operator:team-room",
    };
    publishEvent({
      type: "event",
      event: "templates.add.progress",
      payload: { ...saved, stage: "agent-admitted" },
    });
    expect(context.agents.state.pendingAgent).toBeUndefined();
    expect(context.agents.state.agentsList?.agents.some((row) => row.id === saved.agentId)).toBe(
      true,
    );
    expect(context.chatSubmissions.creation?.admitted).toBe(false);
    expect(
      takeCreatedComposer(context, saved.sessionKey, context.gateway.snapshot.client),
    ).toBeUndefined();
    expect(composer.message).toBe("Still editing");
    expect(composer.inputs.map((input) => input.text)).toEqual(["Buffered follow-up"]);
    expect(
      request.mock.calls.find(([method]) => method === "templates.add.apply")?.[1],
    ).toHaveProperty("agentId", saved.agentId);
    if (outcome === "ready") {
      publishEvent({
        type: "event",
        event: "templates.add.progress",
        payload: { ...saved, stage: "agent-ready" },
      });
      apply.resolve({ ...saved, status: "complete", readiness: { ready: true } });
      await waitForSolid(() => expect(context.chatSubmissions.creating).toBe(false));
      const transfer = takeCreatedComposer(
        context,
        saved.sessionKey,
        context.gateway.snapshot.client,
      );
      expect(transfer?.draft).toBe("Still editing");
      expect(transfer?.inputs.map((input) => input.text)).toEqual(["Buffered follow-up"]);
      transfer?.complete();
    } else {
      apply.resolve({
        ...saved,
        status: "partial",
        agentRetained: true,
        initializationPending: true,
        readiness: { ready: false },
        error: { code: "verification_failed", message: "Template verification failed" },
      });
      await waitForSolid(() => expect(composer.error).toContain("Template verification failed"));
      expect(context.chatSubmissions.readCreate()?.composer).toBe(composer);
      expect(composer.canDisplay()).toBe(true);
      expect(composer.message).toBe("Still editing");
      expect(composer.inputs.map((input) => input.text)).toEqual(["Buffered follow-up"]);
      expect(
        takeCreatedComposer(context, saved.sessionKey, context.gateway.snapshot.client),
      ).toBeUndefined();
    }
    await applying;
    expect(replace).not.toHaveBeenCalled();
    expect(context.router.getState().location.pathname).toBe("/chat/workflow-operator");
    expect(request.mock.calls.filter(([method]) => method === "chat.send")).toHaveLength(0);
    expect(request.mock.calls.filter(([method]) => method === "templates.add.apply")).toHaveLength(
      1,
    );
  },
);

it("retries retained Template setup only on click in the same chat and composer", async () => {
  const { request, context, navigate, replace, publishEvent } = createPage({
    templatesEnabled: true,
    riskConsentRequired: true,
    reviewRequiredOnce: "plugin",
  });
  const source = {
    packageName: workflowOperator.packageName,
    version: workflowOperator.latestVersion,
  };
  const plan = await readTemplateAddReviewPlan(context.gateway.snapshot.client!, source);
  const original = request.getMockImplementation()!;
  const first = createDeferredCore<unknown>();
  const second = createDeferredCore<unknown>();
  let attempts = 0;
  request.mockImplementation((method, params, options) => {
    if (method === "templates.add.apply") {
      attempts += 1;
      options?.onSent?.(attempts === 1 ? "partial-setup" : "retry-setup");
      return attempts === 1 ? first.promise : second.promise;
    }
    return original(method, params, options);
  });
  // Consent was already given at the catalog seam; retry must reuse it, not re-add.
  const applying = addTemplateAgent(context, source, plan, true);
  const creation = context.chatSubmissions.creation;
  const composer = context.chatSubmissions.readCreate()!.composer!;
  composer.setMessage("Buffered follow-up");
  expect(composer.enqueue()).toBe(true);
  composer.setMessage("Draft before setup failed");
  const view = mountSolid(() =>
    createComponent(CreationComposerView, { composer, onOpenImage: () => {} }),
  );
  onTestFinished(view.unmount);
  const saved = {
    agentId: "workflow-operator",
    sessionKey: "agent:workflow-operator:team-room",
  };
  first.resolve({
    ...saved,
    status: "partial",
    agentRetained: true,
    initializationPending: true,
    readiness: { ready: false },
    error: { code: "verification_failed", message: "Template verification failed" },
  });
  await applying;
  expect(attempts).toBe(1);
  await waitForSolid(() => expect(view.getByRole("button", { name: "Retry setup" })).toBeDefined());
  // Editing the retained draft must not erase the recovery action.
  composer.setMessage("Draft edited after setup failed");
  await waitForSolid(() =>
    expect(view.getByRole("button", { name: "Retry setup" })).toHaveProperty("disabled", false),
  );
  const retry = view.getByRole("button", { name: "Retry setup" });
  retry.click();
  retry.click();
  expect(attempts).toBe(2);
  expect(context.chatSubmissions.creation).toBe(creation);
  expect(context.chatSubmissions.readCreate()?.composer).toBe(composer);
  expect(composer.acceptedSessionKey).toBe(saved.sessionKey);
  expect(composer.canAdopt()).toBe(false);
  await waitForSolid(() =>
    expect(view.getByRole("button", { name: "Retry setup" })).toHaveProperty("disabled", true),
  );
  const applies = request.mock.calls.filter(([method]) => method === "templates.add.apply");
  expect(applies).toHaveLength(2);
  expect(applies[1]?.[1]).toEqual(applies[0]?.[1]);
  expect(applies[1]?.[1]).toMatchObject({
    agentId: saved.agentId,
    source,
    planIntegrity: plan.planIntegrity,
    acknowledgeClawHubRisk: true,
  });
  expect(request.mock.calls.filter(([method]) => method === "templates.add.plan")).toHaveLength(1);
  expect(request.mock.calls.filter(([method]) => method === "chat.send")).toHaveLength(0);
  expect(request.mock.calls.filter(([method]) => method === "sessions.create")).toHaveLength(0);
  publishEvent({
    type: "event",
    event: "templates.add.progress",
    payload: { ...saved, requestId: "retry-setup", stage: "agent-ready" },
  });
  second.resolve({ ...saved, status: "complete", readiness: { ready: true } });
  await waitForSolid(() => expect(context.chatSubmissions.creating).toBe(false));
  const transfer = takeCreatedComposer(context, saved.sessionKey, context.gateway.snapshot.client);
  expect(transfer?.draft).toBe("Draft edited after setup failed");
  expect(transfer?.inputs.map((input) => input.text)).toEqual(["Buffered follow-up"]);
  transfer?.complete();
  expect(context.router.getState().location.pathname).toBe("/chat/workflow-operator");
  expect(navigate.mock.calls.filter(([route]) => route === "chat")).toHaveLength(1);
  expect(replace).not.toHaveBeenCalled();
  expect(request.mock.calls.filter(([method]) => method === "templates.add.apply")).toHaveLength(2);
  expect(request.mock.calls.filter(([method]) => method === "chat.send")).toHaveLength(0);
});

it("recovers admitted Template A after creating B while A fails in the background", async () => {
  const { request, context, navigate, publishEvent } = createPage({ templatesEnabled: true });
  const source = {
    packageName: workflowOperator.packageName,
    version: workflowOperator.latestVersion,
  };
  const plan = await readTemplateAddReviewPlan(context.gateway.snapshot.client!, source);
  const original = request.getMockImplementation()!;
  const first = createDeferredCore<unknown>();
  const retry = createDeferredCore<unknown>();
  let attempts = 0;
  request.mockImplementation((method, params, options) => {
    if (method === "templates.add.apply") {
      attempts += 1;
      options?.onSent?.("cross-chat-" + attempts);
      if (attempts === 2) {
        return Promise.resolve({
          agentId: "second-agent",
          sessionKey: "agent:second-agent:team-room",
          status: "complete",
          readiness: { ready: true },
        });
      }
      return attempts === 1 ? first.promise : retry.promise;
    }
    return original(method, params, options);
  });
  const saved = { agentId: "workflow-operator", sessionKey: "agent:workflow-operator:team-room" };
  const applying = addTemplateAgent(context, source, plan, false);
  const composer = context.chatSubmissions.readCreateComposer(saved.sessionKey)!;
  composer.setMessage("A buffered follow-up");
  expect(composer.enqueue()).toBe(true);
  composer.setMessage("A unfinished draft");
  publishEvent({
    type: "event",
    event: "templates.add.progress",
    payload: { ...saved, requestId: "cross-chat-1", stage: "agent-admitted" },
  });
  await waitForSolid(() => expect(context.agents.state.pendingAgent).toBeUndefined());
  await addTemplateAgent(
    context,
    source,
    { ...plan, target: { ...plan.target, agentId: "second-agent", name: "Second agent" } },
    false,
  );
  await waitForSolid(() =>
    expect(context.router.getState().location.pathname).toBe("/chat/second-agent"),
  );
  first.resolve({
    ...saved,
    status: "partial",
    agentRetained: true,
    initializationPending: true,
    readiness: { ready: false },
    error: { code: "verification_failed", message: "A setup failed" },
  });
  await applying;
  expect(context.router.getState().location.pathname).toBe("/chat/second-agent");
  expect(context.chatSubmissions.readCreateComposer(saved.sessionKey)).toBeUndefined();
  context.navigate("chat", { pathname: "/chat/workflow-operator" });
  await waitForSolid(() =>
    expect(context.router.getState().location.pathname).toBe("/chat/workflow-operator"),
  );
  const recovered = context.chatSubmissions.readCreateComposer(saved.sessionKey);
  expect(recovered).toBe(composer);
  expect(context.chatSubmissions.creationFor(saved.sessionKey)?.admitted).toBe(false);
  expect(recovered?.message).toBe("A unfinished draft");
  expect(recovered?.inputs.map((input) => input.text)).toEqual(["A buffered follow-up"]);
  const view = mountSolid(() =>
    createComponent(CreationComposerView, { composer: recovered!, onOpenImage: () => {} }),
  );
  onTestFinished(view.unmount);
  await waitForSolid(() =>
    expect(view.getByRole("button", { name: "Retry setup" })).toHaveProperty("disabled", false),
  );
  expect(attempts).toBe(2);
  view.getByRole("button", { name: "Retry setup" }).click();
  expect(attempts).toBe(3);
  const applies = request.mock.calls.filter(([method]) => method === "templates.add.apply");
  expect(applies[2]?.[1]).toEqual(applies[0]?.[1]);
  retry.resolve({ ...saved, status: "complete", readiness: { ready: true } });
  await waitForSolid(() => expect(context.chatSubmissions.creating).toBe(false));
  expect(context.chatSubmissions.creationFor(saved.sessionKey)).toBeUndefined();
  const transfer = takeCreatedComposer(context, saved.sessionKey, context.gateway.snapshot.client);
  expect(transfer?.draft).toBe("A unfinished draft");
  expect(transfer?.inputs.map((input) => input.text)).toEqual(["A buffered follow-up"]);
  transfer?.complete();
  expect(navigate.mock.calls.filter(([route]) => route === "chat")).toHaveLength(3);
  expect(
    request.mock.calls.filter(([method]) => method === "chat.send" || method === "sessions.create"),
  ).toHaveLength(0);
});
