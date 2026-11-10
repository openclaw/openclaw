/* @vitest-environment jsdom */
import { afterEach, beforeEach, expect, it } from "vitest";
import { createDeferredCore } from "../../../../src/shared/deferred.js";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import { takeCreatedComposer } from "../new-session/creation-composer-registry.ts";
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
    const source = { packageName: workflowOperator.packageName, version: workflowOperator.version };
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
