/* @vitest-environment jsdom */

import { setImmediate as nextTurn } from "node:timers/promises";
import { createComponent } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { createDeferredCore } from "../../../../src/shared/deferred.js";
import { agentCreationRejection } from "../../lib/agents/creation.test-support.ts";
import "../../lib/toast-host.tsx";
// Register the toast renderer before per-test leak tracking.
import "../../lib/toast-view.tsx";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { flush, waitForSolid } from "../../test-helpers/solid-settle.ts";
import { takeCreatedComposer } from "../new-session/creation-composer-registry.ts";
import { TemplatesPage } from "../templates/page.tsx";
import {
  cleanupAgentsHomePageTest,
  createPage,
  setupAgentsHomePageTest,
  workflowOperator,
} from "./agents-home-page.test-helpers.ts";
import { addTemplateAgent } from "./templates-add-agent.ts";
import { createAddSurface, createDetail } from "./templates-catalog.test-helpers.ts";

beforeEach(setupAgentsHomePageTest);
afterEach(cleanupAgentsHomePageTest);

type Requests = ReturnType<typeof createAddSurface>["request"];
const calls = (request: Requests, method: string) =>
  request.mock.calls.filter(([called]) => called === method);
const source = {
  packageName: workflowOperator.packageName,
  version: workflowOperator.latestVersion,
};
/** The whole Add request: no plan digest and no acknowledgements. */
const chatAdd = { mode: "chat", source, agentId: "workflow-operator" };
const sessionKey = "agent:workflow-operator:team-room";

describe("Template Add", () => {
  it.each(["resolved", "failed", "disconnected", "replaced", "disabled"] as const)(
    "admits card Add only from the release's current detail: %s",
    async (outcome) => {
      const { find, request, navigate, setPhase, setTemplatesEnabled, addSelector } =
        createAddSurface("card", { templatesEnabled: false });
      const original = request.getMockImplementation()!;
      const detail = createDeferredCore<unknown>();
      request.mockImplementation((method, params, options) =>
        method === "templates.catalog.detail" ? detail.promise : original(method, params, options),
      );
      setTemplatesEnabled(true);
      await waitForSolid(() => expect(find(addSelector)).toHaveProperty("disabled", false));
      find(addSelector)!.click();
      find(addSelector)!.click();
      await waitForSolid(() => expect(find(addSelector)).toHaveProperty("disabled", true));
      // A card names no agent; only the release's detail does.
      expect(calls(request, "templates.catalog.detail")).toHaveLength(1);
      expect(calls(request, "templates.add.apply")).toHaveLength(0);
      if (outcome === "disconnected") {
        setPhase("reconnecting");
        flush();
        setPhase("connected");
      } else if (outcome === "replaced") {
        find(".agents-home__template-card-link")!.click();
      } else if (outcome === "disabled") {
        setTemplatesEnabled(false);
        await waitForSolid(() => expect(find("[data-templates-explore]")).toBeNull());
      }
      if (outcome === "failed") {
        detail.reject(new Error("Release unavailable"));
        await waitForSolid(() =>
          expect(find("[data-templates-entry] [role=alert]")?.textContent).toContain(
            "Release unavailable",
          ),
        );
        expect(find(addSelector)).toHaveProperty("disabled", false);
      } else {
        detail.resolve(await original("templates.catalog.detail", {}));
        await nextTurn();
        await waitForSolid(() =>
          expect(calls(request, "templates.add.apply")).toHaveLength(
            outcome === "resolved" ? 1 : 0,
          ),
        );
      }
      if (outcome !== "resolved") {
        expect(navigate).not.toHaveBeenCalledWith("chat", expect.anything());
      }
      expect(calls(request, "templates.add.plan")).toHaveLength(0);
    },
  );

  it.each(["card", "detail", "modal"] as const)(
    "sends one plan-free %s Add from same-task clicks and opens pending chat before setup settles",
    async (surface) => {
      const apply = createDeferredCore();
      const { find, request, navigate, context, addSelector } = createAddSurface(surface, {
        templatesEnabled: true,
        applyWait: apply.promise,
      });
      await waitForSolid(() => expect(find(addSelector)).toHaveProperty("disabled", false));
      const button = find(addSelector)!;
      button.click();
      button.click();
      await waitForSolid(() => expect(calls(request, "templates.add.apply")).toHaveLength(1));
      expect(calls(request, "templates.add.apply")[0]![1]).toEqual(chatAdd);
      expect(calls(request, "templates.add.plan")).toHaveLength(0);
      // Nothing is reviewed first: no plugin grants, no skill warnings.
      expect(find(".templates-add-consent")).toBeNull();
      expect(navigate).toHaveBeenCalledWith(
        "chat",
        expect.objectContaining({ pathname: "/chat/workflow-operator" }),
      );
      expect(context.agents.state.pendingAgent).toMatchObject({
        id: "workflow-operator",
        name: "Workflow Operator",
      });
      expect(context.chatSubmissions.creation).toEqual({ sessionKey, admitted: false });
      await waitForSolid(() => expect(context.chatSubmissions.readCreate()).toBeDefined());
      const composer = context.chatSubmissions.readCreate()!.composer!;
      composer.setMessage("Keep this draft while the Template is added");
      button.click();
      expect(calls(request, "templates.add.apply")).toHaveLength(1);
      if (surface === "card") {
        expect(calls(request, "templates.catalog.detail")).toHaveLength(1);
        expect(navigate).not.toHaveBeenCalledWith("templates", expect.anything());
      }
      apply.resolve();
      await waitForSolid(() => expect(context.chatSubmissions.creating).toBe(false));
      expect(context.agents.state.pendingAgent).toBeUndefined();
      const transfer = takeCreatedComposer(context, sessionKey, context.gateway.snapshot.client);
      expect(transfer?.draft).toBe("Keep this draft while the Template is added");
      transfer?.complete();
      expect(navigate.mock.calls.filter(([route]) => route === "chat")).toHaveLength(1);
    },
  );

  it.each(["card", "detail"] as const)(
    "returns a rolled-back %s Add to the catalog with its error and no agent or chat",
    async (surface) => {
      const toast = document.createElement("openclaw-toast-host");
      document.body.append(toast);
      await toast.updateComplete;
      const { find, request, context, replace, publishEvent, addSelector } = createAddSurface(
        surface,
        { templatesEnabled: true },
      );
      await waitForSolid(() => expect(find(addSelector)).toHaveProperty("disabled", false));
      const original = request.getMockImplementation()!;
      const apply = createDeferredCore<unknown>();
      request.mockImplementation((method, params, options) => {
        if (method === "templates.add.apply") {
          options?.onSent?.("add-request");
          return apply.promise;
        }
        return original(method, params, options);
      });
      const origin = context.router.getState().location;
      find(addSelector)!.click();
      await waitForSolid(() => expect(context.chatSubmissions.readCreate()).toBeDefined());
      // The Gateway admitted the agent and chat before it failed to fetch the Template.
      publishEvent({
        type: "event",
        event: "templates.add.progress",
        payload: {
          requestId: "add-request",
          stage: "agent-admitted",
          agentId: "workflow-operator",
          sessionKey,
        },
      });
      expect(
        context.agents.state.agentsList?.agents.some((agent) => agent.id === "workflow-operator"),
      ).toBe(true);
      apply.reject(agentCreationRejection("ClawHub could not deliver this Template."));
      const shown = surface === "card" ? "[data-templates-entry] [role=alert]" : "[role=alert]";
      await waitForSolid(() =>
        expect(find(shown)?.textContent).toContain("ClawHub could not deliver this Template."),
      );
      expect(replace).toHaveBeenCalledWith("templates", origin);
      expect(context.router.getState().location.pathname).toBe(origin.pathname);
      expect(context.agents.state.pendingAgent).toBeUndefined();
      expect(context.chatSubmissions.creating).toBe(false);
      expect(context.chatSubmissions.creationFor(sessionKey)).toBeUndefined();
      expect(
        takeCreatedComposer(context, sessionKey, context.gateway.snapshot.client),
      ).toBeUndefined();
      await waitForSolid(() =>
        expect(
          context.agents.state.agentsList?.agents.some((agent) => agent.id === "workflow-operator"),
        ).toBe(false),
      );
      // The card carries the error; Add is available again and nothing was retried.
      expect(toast.toasts).toHaveLength(0);
      expect(find(addSelector)).toHaveProperty("disabled", false);
      expect(calls(request, "templates.add.apply")).toHaveLength(1);
    },
  );

  it("shows a rolled-back Add on the catalog page opened after it failed", async () => {
    const { request, context, wrapper, unmountPage } = createPage({ templatesEnabled: true });
    await waitForSolid(() => expect(context.agents.state.agentsList).not.toBeNull());
    // The catalog page that started an Add closes when the new chat opens.
    unmountPage();
    const original = request.getMockImplementation()!;
    request.mockImplementation((method, params, options) =>
      method === "templates.add.apply"
        ? Promise.reject(agentCreationRejection("ClawHub could not deliver this Template."))
        : original(method, params, options),
    );
    await addTemplateAgent(
      context,
      { entry: workflowOperator, source, agentId: "workflow-operator" },
      false,
    );
    const openCatalog = () => {
      const view = mountSolid(
        () =>
          createComponent(TemplatesPage, {
            routeData: { basePath: "", location: { pathname: "/templates", search: "", hash: "" } },
          }),
        { wrapper },
      );
      onTestFinished(view.unmount);
      return view;
    };
    const reopened = openCatalog();
    await waitForSolid(() =>
      expect(
        reopened.container.querySelector("[data-templates-entry] [role=alert]")?.textContent,
      ).toContain("ClawHub could not deliver this Template."),
    );
    // Shown once: the next visit to the catalog starts clean.
    reopened.unmount();
    const revisited = openCatalog().container;
    await waitForSolid(() =>
      expect(revisited.querySelector("[data-templates-entry]")).toBeTruthy(),
    );
    expect(revisited.querySelector("[role=alert]")).toBeNull();
  });

  it.each(["card", "detail", "modal"] as const)(
    "returns a flagged %s release for the user's decision and applies once on duplicate confirmation",
    async (surface) => {
      const { find, request, navigate, replace, context, addSelector } = createAddSurface(surface, {
        templatesEnabled: true,
        riskConsentRequired: true,
      });
      await waitForSolid(() => expect(find(addSelector)).toHaveProperty("disabled", false));
      const origin = context.router.getState().location;
      find(addSelector)!.click();
      // The Gateway refuses the unacknowledged release and keeps nothing.
      await waitForSolid(() => expect(find(".templates-trust-warning")).not.toBeNull());
      expect(calls(request, "templates.add.apply").map(([, params]) => params)).toEqual([chatAdd]);
      expect(replace).toHaveBeenCalledWith("templates", origin);
      expect(context.chatSubmissions.creating).toBe(false);
      expect(context.agents.state.pendingAgent).toBeUndefined();
      const confirm = find(".templates-add-consent__actions .btn.primary")!;
      confirm.click();
      confirm.click();
      await waitForSolid(() => expect(calls(request, "templates.add.apply")).toHaveLength(2));
      expect(calls(request, "templates.add.apply")[1]![1]).toEqual({
        ...chatAdd,
        acknowledgeClawHubRisk: true,
      });
      await waitForSolid(() => expect(context.chatSubmissions.creating).toBe(false));
      expect(navigate.mock.calls.filter(([route]) => route === "chat")).toHaveLength(2);
      expect(calls(request, "templates.add.apply")).toHaveLength(2);
    },
  );

  it("isolates a successor pending chat from a disconnected Add's late result", async () => {
    const { find, request, navigate, context, setPhase } = createDetail({ templatesEnabled: true });
    await waitForSolid(() =>
      expect(find("[data-templates-confirm] button")).toHaveProperty("disabled", false),
    );
    const original = request.getMockImplementation()!;
    const oldApply = createDeferredCore<unknown>();
    const newApply = createDeferredCore<unknown>();
    let applications = 0;
    request.mockImplementation((method, params, options) => {
      if (method === "templates.add.apply") {
        return applications++ === 0 ? oldApply.promise : newApply.promise;
      }
      return original(method, params, options);
    });
    find("[data-templates-confirm] button")!.click();
    const oldCreation = context.chatSubmissions.creation;
    setPhase("reconnecting");
    flush();
    setPhase("connected");
    await waitForSolid(() =>
      expect(find("[data-templates-confirm] button")).toHaveProperty("disabled", false),
    );
    find("[data-templates-confirm] button")!.click();
    const successor = context.chatSubmissions.creation;
    expect(successor).not.toBe(oldCreation);
    oldApply.resolve({
      agentId: "workflow-operator",
      sessionKey: "agent:workflow-operator:team-room",
      status: "complete",
      readiness: { ready: true },
    });
    await nextTurn();
    expect(context.chatSubmissions.creation).toBe(successor);
    expect(successor?.admitted).toBe(false);
    expect(context.agents.state.pendingAgent?.id).toBe("workflow-operator");
    expect(navigate.mock.calls.filter(([route]) => route === "chat")).toHaveLength(2);
    newApply.resolve({
      agentId: "workflow-operator",
      sessionKey: "agent:workflow-operator:team-room",
      status: "complete",
      readiness: { ready: true },
    });
    await waitForSolid(() => expect(context.chatSubmissions.creating).toBe(false));
    expect(successor?.admitted).toBe(true);
    expect(applications).toBe(2);
  });

  it("opens the created chat without waiting for a roster refresh", async () => {
    const { find, request, navigate, context } = createDetail({ templatesEnabled: true });
    await waitForSolid(() =>
      expect(find("[data-templates-confirm] button")).toHaveProperty("disabled", false),
    );
    const original = request.getMockImplementation()!;
    request.mockImplementation((method, params, options) => {
      if (method === "agents.list") {
        throw new Error("Roster unavailable");
      }
      return original(method, params, options);
    });
    find("[data-templates-confirm] button")!.click();
    expect(navigate).toHaveBeenCalledWith(
      "chat",
      expect.objectContaining({ pathname: "/chat/workflow-operator" }),
    );
    await waitForSolid(() => expect(context.chatSubmissions.creating).toBe(false));
    expect(context.agentSelection.state.selectedId).toBe("workflow-operator");
    expect(request.mock.calls.filter(([method]) => method === "templates.add.apply")).toHaveLength(
      1,
    );
  });

  it.each(["agent-kept", "request-lost"] as const)(
    "reports an Add that did not roll back and preserves only an admitted chat: %s",
    async (stage) => {
      const toast = document.createElement("openclaw-toast-host");
      document.body.append(toast);
      await toast.updateComplete;
      const { find, request, context, replace, publishEvent } = createDetail({
        templatesEnabled: true,
      });
      await waitForSolid(() =>
        expect(find("[data-templates-confirm] button")).toHaveProperty("disabled", false),
      );
      const original = request.getMockImplementation()!;
      const apply = createDeferredCore<unknown>();
      request.mockImplementation((method, params, options) => {
        if (method === "templates.add.apply") {
          options?.onSent?.("add-request");
          return apply.promise;
        }
        return original(method, params, options);
      });
      const origin = context.router.getState().location;
      find("[data-templates-confirm] button")!.click();
      await waitForSolid(() => expect(context.chatSubmissions.readCreate()).toBeDefined());
      const composer = context.chatSubmissions.readCreate()!.composer!;
      composer.setMessage("My next step");
      if (stage === "agent-kept") {
        publishEvent({
          type: "event",
          event: "templates.add.progress",
          payload: {
            requestId: "add-request",
            stage: "agent-ready",
            agentId: "workflow-operator",
            sessionKey,
          },
        });
        expect(context.chatSubmissions.creating).toBe(false);
        apply.resolve({
          agentId: "workflow-operator",
          sessionKey,
          status: "partial",
          agentRetained: true,
          readiness: { ready: false },
          error: { code: "SETUP_FAILED", message: "Dependency setup failed" },
        });
      } else {
        // No Gateway answer: nothing says the agent was removed.
        apply.reject(new Error("Dependency setup failed"));
      }
      await waitForSolid(() => expect(toast.textContent).toContain("Dependency setup failed"));
      // An earlier test's roster failure can still be on screen; read this Add's own toast.
      const severity = toast.toasts.find(
        (entry) => entry.options.message === "Dependency setup failed",
      )?.options.severity;
      expect(context.agents.state.pendingAgent).toBeUndefined();
      expect(context.chatSubmissions.creating).toBe(false);
      expect(find("[role=alert]")).toBeNull();
      if (stage === "agent-kept") {
        expect(replace).not.toHaveBeenCalled();
        expect(context.router.getState().location.pathname).toBe("/chat/workflow-operator");
        const transfer = takeCreatedComposer(context, sessionKey, context.gateway.snapshot.client);
        expect(transfer?.draft).toBe("My next step");
        transfer?.complete();
        expect(severity).toBe("warning");
      } else {
        expect(replace).toHaveBeenCalledWith("templates", origin);
        expect(context.router.getState().location.pathname).toBe(origin.pathname);
        expect(severity).toBe("error");
      }
      expect(calls(request, "templates.add.apply")).toHaveLength(1);
    },
  );

  it("retains the selected Template on revalidation and clears it when the package changes", async () => {
    const { detail, request, setPackageName } = createDetail({ templatesEnabled: true });

    await vi.waitFor(() =>
      expect(detail.querySelector(".plugin-capabilities")?.textContent).toContain("AGENTS.md"),
    );
    const selected = detail.querySelector(".plugin-capabilities");
    const details = request.mock.calls.filter(([method]) => method === "templates.catalog.detail");
    setPackageName(workflowOperator.packageName);
    await waitForSolid(() => {
      expect(detail.querySelector(".plugin-capabilities")).toBe(selected);
      expect(
        request.mock.calls.filter(([method]) => method === "templates.catalog.detail"),
      ).toEqual(details);
    });
    setPackageName("@openclaw/another-template");

    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith("templates.catalog.detail", {
        packageName: "@openclaw/another-template",
      }),
    );
    await vi.waitFor(() => expect(detail.querySelector(".plugin-capabilities")).toBeNull());
    expect(detail.querySelector<HTMLButtonElement>("[data-templates-confirm] button")).toBeNull();
  });

  it("keeps an admitted Add app-owned across package route changes without stealing navigation", async () => {
    const apply = createDeferredCore();
    const { find, request, navigate, replace, context, setPackageName } = createDetail({
      templatesEnabled: true,
      applyWait: apply.promise,
    });
    await waitForSolid(() =>
      expect(find("[data-templates-confirm] button")).toHaveProperty("disabled", false),
    );
    find("[data-templates-confirm] button")!.click();
    expect(navigate).toHaveBeenCalledWith(
      "chat",
      expect.objectContaining({ pathname: "/chat/workflow-operator" }),
    );
    setPackageName("@openclaw/another-template");
    await waitForSolid(() => expect(find(".plugin-capabilities")).toBeNull());
    setPackageName(workflowOperator.packageName);
    await waitForSolid(() => expect(find(".plugin-capabilities")).not.toBeNull());
    expect(find("[data-templates-confirm] button")).toHaveProperty("disabled", true);
    const location = context.router.getState().location;
    apply.resolve();
    await waitForSolid(() => expect(context.chatSubmissions.creating).toBe(false));
    expect(context.agents.state.pendingAgent).toBeUndefined();
    expect(context.router.getState().location).toBe(location);
    expect(replace).not.toHaveBeenCalled();
    expect(navigate.mock.calls.filter(([route]) => route === "chat")).toHaveLength(1);
    expect(request.mock.calls.filter(([method]) => method === "templates.add.apply")).toHaveLength(
      1,
    );
  });

  it("asks again after a cancelled ClawHub trust warning", async () => {
    const { detail, request, navigate } = createDetail({
      templatesEnabled: true,
      riskConsentRequired: true,
      clawHubTrustWarning: "Review this release before adding it.",
    });
    const add = () => detail.querySelector<HTMLButtonElement>("[data-templates-confirm] button");
    await vi.waitFor(() => expect(add()?.disabled).toBe(false));
    add()?.click();
    await vi.waitFor(() =>
      expect(detail.querySelector(".templates-trust-warning")?.textContent).toContain(
        "Review this release before adding it.",
      ),
    );

    detail.querySelector<HTMLButtonElement>(".templates-add-consent__actions .btn")?.click();
    await vi.waitFor(() => expect(detail.querySelector(".templates-add-consent")).toBeNull());
    add()?.click();
    await vi.waitFor(() => expect(detail.querySelector(".templates-trust-warning")).not.toBeNull());
    // Cancelling acknowledged nothing: the second request is as unacknowledged as the first.
    expect(calls(request, "templates.add.apply").map(([, params]) => params)).toEqual([
      chatAdd,
      chatAdd,
    ]);

    detail
      .querySelector<HTMLButtonElement>(".templates-add-consent__actions .btn.primary")
      ?.click();
    await vi.waitFor(() => expect(calls(request, "templates.add.apply")).toHaveLength(3));
    expect(calls(request, "templates.add.apply")[2]![1]).toEqual({
      ...chatAdd,
      acknowledgeClawHubRisk: true,
    });
    expect(navigate.mock.calls.filter(([route]) => route === "chat")).toHaveLength(3);
  });
});
