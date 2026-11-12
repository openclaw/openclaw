/* @vitest-environment jsdom */

import { setImmediate as nextTurn } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferredCore } from "../../../../src/shared/deferred.js";
import { GatewayRequestError } from "../../api/gateway-connect-errors.ts";
import "../../lib/toast-host.tsx";
// Register the toast renderer before per-test leak tracking.
import "../../lib/toast-view.tsx";
import { flush, waitForSolid } from "../../test-helpers/solid-settle.ts";
import { takeCreatedComposer } from "../new-session/creation-composer-registry.ts";
import {
  cleanupAgentsHomePageTest,
  setupAgentsHomePageTest,
  workflowOperator,
} from "./agents-home-page.test-helpers.ts";
import { createAddSurface, createDetail } from "./templates-catalog.test-helpers.ts";

beforeEach(setupAgentsHomePageTest);
afterEach(cleanupAgentsHomePageTest);

describe("Template Add", () => {
  it.each([
    { surface: "detail", outcome: "prepared" },
    { surface: "detail", outcome: "failed" },
    { surface: "card", outcome: "prepared" },
    { surface: "card", outcome: "failed" },
    { surface: "card", outcome: "disconnected" },
    { surface: "card", outcome: "replaced" },
    { surface: "card", outcome: "disabled" },
  ] as const)(
    "admits $surface Add only from a current authoritative plan: $outcome",
    async ({ surface, outcome }) => {
      const { find, request, navigate, setPhase, setTemplatesEnabled, addSelector } =
        createAddSurface(surface, { templatesEnabled: false });
      const original = request.getMockImplementation()!;
      const plan = createDeferredCore<unknown>();
      request.mockImplementation((method, params, options) =>
        method === "templates.add.plan" ? plan.promise : original(method, params, options),
      );
      setTemplatesEnabled(true);
      if (surface === "card") {
        await waitForSolid(() => expect(find(addSelector)).toHaveProperty("disabled", false));
        find(addSelector)!.click();
        find(addSelector)!.click();
      } else {
        await waitForSolid(() => expect(find(".plugin-capabilities")).not.toBeNull());
      }
      await waitForSolid(() => expect(find(addSelector)).toHaveProperty("disabled", true));
      expect(request.mock.calls.filter(([method]) => method === "templates.add.plan")).toHaveLength(
        1,
      );
      expect(
        request.mock.calls.filter(([method]) => method === "templates.add.apply"),
      ).toHaveLength(0);
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
        plan.reject(new Error("Release review unavailable"));
        await waitForSolid(() =>
          expect(find("[role=alert]")?.textContent).toContain("Release review unavailable"),
        );
        expect(find(addSelector)).toHaveProperty("disabled", surface === "detail");
      } else {
        plan.resolve(await original("templates.add.plan", {}));
        await nextTurn();
        await waitForSolid(() =>
          expect(
            request.mock.calls.filter(([method]) => method === "templates.add.apply"),
          ).toHaveLength(surface === "card" && outcome === "prepared" ? 1 : 0),
        );
        if (surface === "detail") {
          expect(find(addSelector)).toHaveProperty("disabled", false);
        } else if (outcome !== "prepared") {
          expect(navigate).not.toHaveBeenCalledWith("chat", expect.anything());
        }
      }
    },
  );

  it.each(["card", "detail", "modal"] as const)(
    "admits one %s Add from same-task clicks and opens pending chat before setup settles",
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
      await waitForSolid(() =>
        expect(
          request.mock.calls.filter(([method]) => method === "templates.add.apply"),
        ).toHaveLength(1),
      );
      expect(navigate).toHaveBeenCalledWith(
        "chat",
        expect.objectContaining({ pathname: "/chat/workflow-operator" }),
      );
      expect(context.agents.state.pendingAgent).toMatchObject({
        id: "workflow-operator",
        name: "Workflow Operator",
      });
      expect(context.chatSubmissions.creation).toEqual({
        sessionKey: "agent:workflow-operator:team-room",
        admitted: false,
      });
      await waitForSolid(() => expect(context.chatSubmissions.readCreate()).toBeDefined());
      const composer = context.chatSubmissions.readCreate()!.composer!;
      composer.setMessage("Keep this draft while the Template is added");
      button.click();
      expect(
        request.mock.calls.filter(([method]) => method === "templates.add.apply"),
      ).toHaveLength(1);
      if (surface === "card") {
        expect(
          request.mock.calls.filter(([method]) => method === "templates.catalog.detail"),
        ).toHaveLength(0);
        expect(navigate).not.toHaveBeenCalledWith("templates", expect.anything());
      }
      apply.resolve();
      await waitForSolid(() => expect(context.chatSubmissions.creating).toBe(false));
      expect(context.agents.state.pendingAgent).toBeUndefined();
      const transfer = takeCreatedComposer(
        context,
        "agent:workflow-operator:team-room",
        context.gateway.snapshot.client,
      );
      expect(transfer?.draft).toBe("Keep this draft while the Template is added");
      transfer?.complete();
      expect(navigate.mock.calls.filter(([route]) => route === "chat")).toHaveLength(1);
    },
  );

  it.each(["card", "detail", "modal"] as const)(
    "requires risk consent for %s Add before pending chat and applies once on duplicate confirmation",
    async (surface) => {
      const apply = createDeferredCore();
      const { find, request, navigate, context, addSelector } = createAddSurface(surface, {
        templatesEnabled: true,
        riskConsentRequired: true,
        applyWait: apply.promise,
      });
      await waitForSolid(() => expect(find(addSelector)).toHaveProperty("disabled", false));
      find(addSelector)!.click();
      await waitForSolid(() => expect(find(".templates-trust-warning")).not.toBeNull());
      expect(context.chatSubmissions.creating).toBe(false);
      expect(navigate).not.toHaveBeenCalledWith("chat", expect.anything());
      expect(
        request.mock.calls.filter(([method]) => method === "templates.add.apply"),
      ).toHaveLength(0);
      const confirm = find(".templates-add-consent__actions .btn.primary")!;
      confirm.click();
      confirm.click();
      expect(
        request.mock.calls.filter(([method]) => method === "templates.add.apply"),
      ).toHaveLength(1);
      expect(
        request.mock.calls.findLast(([method]) => method === "templates.add.apply")?.[1],
      ).toHaveProperty("acknowledgeClawHubRisk", true);
      expect(navigate).toHaveBeenCalledWith("chat", expect.anything());
      expect(context.chatSubmissions.creating).toBe(true);
      apply.resolve();
      await waitForSolid(() => expect(context.chatSubmissions.creating).toBe(false));
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

  it.each(["before-agent-ready", "after-agent-ready"] as const)(
    "reports Add failure %s and preserves only an admitted chat",
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
      if (stage === "after-agent-ready") {
        publishEvent({
          type: "event",
          event: "templates.add.progress",
          payload: {
            requestId: "add-request",
            stage: "agent-ready",
            agentId: "workflow-operator",
            sessionKey: "agent:workflow-operator:team-room",
          },
        });
        expect(context.chatSubmissions.creating).toBe(false);
        apply.resolve({
          agentId: "workflow-operator",
          sessionKey: "agent:workflow-operator:team-room",
          status: "partial",
          agentRetained: true,
          readiness: { ready: false },
          error: { code: "SETUP_FAILED", message: "Dependency setup failed" },
        });
      } else {
        apply.reject(
          new GatewayRequestError({ code: "INVALID_REQUEST", message: "Dependency setup failed" }),
        );
      }
      await waitForSolid(() => expect(toast.textContent).toContain("Dependency setup failed"));
      expect(context.agents.state.pendingAgent).toBeUndefined();
      expect(context.chatSubmissions.creating).toBe(false);
      if (stage === "after-agent-ready") {
        expect(replace).not.toHaveBeenCalled();
        expect(context.router.getState().location.pathname).toBe("/chat/workflow-operator");
        const transfer = takeCreatedComposer(
          context,
          "agent:workflow-operator:team-room",
          context.gateway.snapshot.client,
        );
        expect(transfer?.draft).toBe("My next step");
        transfer?.complete();
        expect(toast.toasts.at(-1)?.options.severity).toBe("warning");
      } else {
        expect(replace).toHaveBeenCalledWith("templates", origin);
        expect(context.router.getState().location.pathname).toBe(origin.pathname);
        expect(toast.toasts.at(-1)?.options.severity).toBe("error");
      }
      expect(
        request.mock.calls.filter(([method]) => method === "templates.add.apply"),
      ).toHaveLength(1);
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

  it("asks before acknowledging a ClawHub trust warning", async () => {
    const { detail, request, navigate } = createDetail({
      templatesEnabled: true,
      riskConsentRequired: true,
      clawHubTrustWarning: "Review this release before adding it.",
    });

    await vi.waitFor(() =>
      expect(
        detail.querySelector<HTMLButtonElement>("[data-templates-confirm] button")?.disabled,
      ).toBe(false),
    );
    detail.querySelector<HTMLButtonElement>("[data-templates-confirm] button")?.click();

    await vi.waitFor(() =>
      expect(detail.querySelector(".templates-trust-warning")?.textContent).toContain(
        "Review this release before adding it.",
      ),
    );
    expect(request.mock.calls.filter(([method]) => method === "templates.add.apply")).toHaveLength(
      0,
    );
    expect(navigate).not.toHaveBeenCalledWith("chat", expect.anything());

    detail.querySelector<HTMLButtonElement>(".templates-add-consent__actions .btn")?.click();
    await vi.waitFor(() => expect(detail.querySelector(".templates-add-consent")).toBeNull());
    detail.querySelector<HTMLButtonElement>("[data-templates-confirm] button")?.click();
    await vi.waitFor(() =>
      expect(
        request.mock.calls.filter(([method]) => method === "templates.add.apply"),
      ).toHaveLength(0),
    );
    await vi.waitFor(() => expect(detail.querySelector(".templates-trust-warning")).not.toBeNull());

    detail
      .querySelector<HTMLButtonElement>(".templates-add-consent__actions .btn.primary")
      ?.click();
    await vi.waitFor(() => expect(navigate).toHaveBeenCalledWith("chat", expect.anything()));
    expect(
      request.mock.calls.findLast(([method]) => method === "templates.add.apply")?.[1],
    ).toHaveProperty("acknowledgeClawHubRisk", true);
  });

  it.each([
    { kind: "plugin", bundled: false },
    { kind: "skill", bundled: false },
    { kind: "plugin", bundled: true },
    { kind: "skill", bundled: true },
  ] as const)(
    "asks before applying a direct catalog $kind review plan (bundled=$bundled)",
    async ({ kind, bundled }) => {
      const { find, request, navigate, addSelector } = createAddSurface("card", {
        templatesEnabled: true,
        reviewRequiredOnce: kind,
        bundledReview: bundled,
      });

      await vi.waitFor(() => expect(find(addSelector)?.matches(":disabled")).toBe(false));
      find(addSelector)!.click();

      await vi.waitFor(() =>
        expect(find(".templates-add-consent")?.textContent).toContain(
          bundled
            ? kind === "plugin"
              ? "workflow-tools"
              : "research"
            : kind === "plugin"
              ? "@openclaw/workflow-tools"
              : "@openclaw/research",
        ),
      );
      if (kind === "plugin") {
        expect(find(".templates-add-consent")?.textContent).toContain(
          "Conversation access: Allowed",
        );
      }
      if (bundled) {
        expect(find(".templates-add-consent")?.textContent).not.toContain("Version undefined");
      }
      expect(request.mock.calls.filter(([method]) => method === "templates.add.plan")).toHaveLength(
        1,
      );
      expect(
        request.mock.calls.filter(([method]) => method === "templates.add.apply"),
      ).toHaveLength(0);
      expect(navigate).not.toHaveBeenCalledWith("chat", expect.anything());

      find(".templates-add-consent__actions .btn.primary")!.click();
      await vi.waitFor(() => expect(navigate).toHaveBeenCalledWith("chat", expect.anything()));
      const applyParams = request.mock.calls.findLast(
        ([method]) => method === "templates.add.apply",
      )?.[1];
      expect(applyParams).toHaveProperty("planIntegrity", "sha256:reviewed-plan");
      expect(applyParams).toHaveProperty(
        kind === "plugin" ? "acknowledgeCapabilities" : "acknowledgeSkillWarnings",
        [
          expect.objectContaining({
            actionId:
              kind === "plugin" ? "plugin:@openclaw/workflow-tools" : "skill:@openclaw/research",
            reviewToken: kind === "plugin" ? "review-workflow-tools" : "review-research",
            acknowledgeRiskWarning: true,
            ...(bundled && kind === "skill"
              ? { source: "bundled", path: "skills/research", digest: `sha256:${"b".repeat(64)}` }
              : {}),
          }),
        ],
      );
      expect(applyParams).not.toHaveProperty("acknowledgeClawHubRisk");
    },
  );

  it("requires both consents for direct catalog Add when trust and plugin review are needed", async () => {
    const { find, request, navigate, addSelector } = createAddSurface("card", {
      templatesEnabled: true,
      riskConsentRequired: true,
      reviewRequiredOnce: "plugin",
    });

    await vi.waitFor(() => expect(find(addSelector)?.matches(":disabled")).toBe(false));
    find(addSelector)!.click();
    await vi.waitFor(() => expect(find(".templates-trust-warning")).not.toBeNull());
    find(".templates-add-consent__actions .btn.primary")!.click();

    await vi.waitFor(() =>
      expect(find(".templates-add-consent")?.textContent ?? "").toContain(
        "@openclaw/workflow-tools",
      ),
    );
    expect(request.mock.calls.filter(([method]) => method === "templates.add.apply")).toHaveLength(
      0,
    );
    expect(navigate).not.toHaveBeenCalledWith("chat", expect.anything());

    find(".templates-add-consent__actions .btn.primary")!.click();
    await vi.waitFor(() => expect(navigate).toHaveBeenCalledWith("chat", expect.anything()));
    const applyParams = request.mock.calls.findLast(
      ([method]) => method === "templates.add.apply",
    )?.[1];
    expect(applyParams).toHaveProperty("acknowledgeClawHubRisk", true);
    expect(applyParams).toHaveProperty("planIntegrity", "sha256:reviewed-plan");
  });
});
