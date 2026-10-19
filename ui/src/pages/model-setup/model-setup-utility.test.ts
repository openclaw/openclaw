/* @vitest-environment jsdom */
import { describe, expect, it, vi } from "vitest";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import {
  persistFirstRunActivationReceipt,
  readFirstRunActivationReceipt,
} from "./first-run-activation-receipt.ts";
import {
  candidate,
  clickCandidate,
  createFirstRunContext,
  detection,
  mountDetection,
  useFirstRunFixtures,
  selectManualProvider,
  setInput,
  authButton,
  waitForText,
  pageButton,
  authOption,
  mockRequests,
  activated,
  modalButton,
} from "./model-setup-first-run.test-support.ts";

type Fixture = ReturnType<typeof createFirstRunContext>;
const utility = {
  ...candidate("provider-auto:local", "local/setup", true),
  modelTarget: "utility" as const,
};
const { kind: candidateKind, modelRef, modelTarget } = utility;
const activatedUtility = activated(modelRef, { modelTarget });
const utilitySelection = { kind: candidateKind, modelRef, modelTarget };
const onboarding = { search: "?onboarding=1" };
const primaryModel = { configuredModel: "cloud/primary", setupComplete: true };
const configuredUtility = { candidates: [utility], utilityModel: modelRef };
const utilityAuth = { ...authOption("utility-login", "Login"), modelTarget };
const utilityKey = { id: "manual-utility", label: "API key", modelTarget };

const expectRequest = (request: Fixture["request"], method: string, params: object) =>
  expect(request).toHaveBeenCalledWith(method, expect.objectContaining(params), expect.anything());
const expectAssistant = (context: Fixture["context"]) =>
  waitForFast(() => expect(context.navigate).toHaveBeenCalledWith("custodian", onboarding));

function createUtilityContext() {
  const fixture = createFirstRunContext();
  return {
    ...fixture,
    mount: mountDetection.bind(null, fixture.context, fixture.client),
  };
}

describe("ModelSetupPage utility roles", () => {
  useFirstRunFixtures("synthetic-utility-device-key");

  it("opens the assistant after utility activation outside first run", async () => {
    const { context, request, mount } = createUtilityContext();
    request.mockResolvedValue(activatedUtility);
    const { page } = await mount({ candidates: [utility] }, false);
    expect(page.textContent).toContain("Setup & utility");
    expect(page.textContent).toContain("Use for setup");
    expect(request).not.toHaveBeenCalled();
    await clickCandidate(page, utility.kind);
    await waitForText(page, "Setup & utility model ready");
    const success = page.querySelector(".model-setup-success")!;
    expect(success.textContent).not.toMatch(/start chatting|Active model/u);
    modalButton(page, "Open setup assistant")!.click();
    await expectAssistant(context);
    expect(request.mock.calls[0]?.[1]).toMatchObject(utilitySelection);
    expect(context.navigate).not.toHaveBeenCalledWith("chat");
  });

  it.each([false, true])(
    "reopens and repairs a configured utility (primary: %s)",
    async (primary) => {
      const { context, request, mount } = createUtilityContext();
      request.mockResolvedValue(activatedUtility);
      const { page } = await mount({
        ...configuredUtility,
        ...(primary ? primaryModel : { setupModel: utility.modelRef }),
      });

      expect(page.querySelector(".model-setup__current") !== null).toBe(primary);
      expect(page.querySelector(`[data-candidate-kind="${utility.kind}"]`)).toBeNull();
      expect(page.textContent).toContain(
        primary
          ? "Regular chats use your primary model"
          : "Choose a primary model below for regular chats",
      );
      const buttons = [...page.querySelectorAll<HTMLButtonElement>(".model-setup__utility button")];
      buttons.find((button) => button.textContent?.includes("Open setup assistant"))!.click();
      expect(context.navigate).toHaveBeenCalledWith("custodian", primary ? {} : onboarding);
      expect(request).not.toHaveBeenCalled();
      buttons.find((button) => button.textContent?.includes("Recheck & repair"))!.click();
      await waitForFast(() =>
        expectRequest(request, "openclaw.setup.activate.start", utilitySelection),
      );
    },
  );

  it.each(["api-key", "oauth"] as const)(
    "preserves utility acknowledgement through %s setup",
    async (kind) => {
      const { context, request, mount } = createUtilityContext();
      const oauth = kind === "oauth";
      const method = oauth ? "openclaw.setup.auth.start" : "openclaw.setup.activate.start";
      const params = {
        authChoice: oauth ? "utility-login" : "manual-utility",
        modelTarget,
        ...(oauth ? {} : { kind, apiKey: "synthetic-utility-key" }),
      };
      if (oauth) {
        vi.spyOn(window, "open").mockReturnValue(null);
      }
      mockRequests(request, {
        [method]: () => (oauth ? { done: false, status: "running" } : activatedUtility),
        "wizard.next": () => {
          if (!oauth) {
            throw new Error("Unexpected method wizard.next");
          }
          expect(readFirstRunActivationReceipt(context)).toMatchObject({
            kind: "provider-auth",
            modelTarget: "utility",
            modelRef: null,
          });
          return activatedUtility;
        },
      });
      const { page } = await mount(
        oauth ? { authOptions: [utilityAuth] } : { manualProviders: [utilityKey] },
      );
      if (oauth) {
        authButton(page, "utility-login")!.click();
      } else {
        await selectManualProvider(page, "manual-utility");
        setInput(page, 'input[type="password"]', "synthetic-utility-key");
        await page.updateComplete;
        pageButton(page, ".model-setup__manual .btn.primary")!.click();
      }
      await expectAssistant(context);
      expectRequest(request, method, params);
      expect(request.mock.calls.map(([called]) => called)).toEqual([
        method,
        ...(oauth ? ["wizard.next"] : []),
      ]);
    },
  );

  it.each(["direct", "detected", "missing"] as const)(
    "keeps the utility role for %s preparation",
    async (outcome) => {
      const { context, request, mount } = createUtilityContext();
      const direct = outcome === "direct";
      const usable = outcome !== "missing";
      const prepared = {
        ...detection,
        ...(direct ? {} : primaryModel),
        prepareOptions: [{ id: "local", label: "Local utility", modelTarget: "utility" as const }],
      };
      mockRequests(request, {
        "openclaw.setup.prepare.start": () => ({
          done: true,
          status: "done",
          ...(direct ? { preparedModelRef: utility.modelRef } : {}),
        }),
        "openclaw.setup.detect": () => {
          if (direct) {
            throw new Error("Unexpected method openclaw.setup.detect");
          }
          return { ...prepared, utilityModel: modelRef, candidates: usable ? [utility] : [] };
        },
        "openclaw.setup.activate.start": () => activatedUtility,
      });
      const { page } = await mount(prepared, direct);
      pageButton(page, '[data-prepare-choice="local"] button')!.click();
      if (direct) {
        await expectAssistant(context);
      } else {
        await waitForText(
          page,
          usable
            ? "Setup & utility model ready"
            : "Local utility did not expose a usable local model",
        );
        expect(page.querySelector(".model-setup__current")?.textContent).toContain("primary");
        expect(page.querySelector(".model-setup__utility")).toBeNull();
      }
      expect(request.mock.calls.map(([method]) => method)).toEqual([
        "openclaw.setup.prepare.start",
        ...(direct ? [] : ["openclaw.setup.detect"]),
        ...(usable ? ["openclaw.setup.activate.start"] : []),
      ]);
      if (usable) {
        expectRequest(request, "openclaw.setup.activate.start", {
          agentId: "main",
          ...utilitySelection,
        });
      }
    },
  );

  it.each(["utility", undefined] as const)(
    "recovers only utility-qualified verification: %s",
    async (replyTarget) => {
      const { context, request, mount } = createUtilityContext();
      persistFirstRunActivationReceipt(context, utility);
      request.mockResolvedValue({
        ok: true,
        modelRef: utility.modelRef,
        ...(replyTarget ? { modelTarget: replyTarget } : {}),
      });
      const { page } = await mount({ ...configuredUtility, ...primaryModel });
      await waitForFast(() => expect(request).toHaveResolved());
      await page.updateComplete;

      expect(request).toHaveBeenCalledWith(
        "openclaw.setup.verify",
        { agentId: "main", modelTarget: "utility" },
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
      if (replyTarget) {
        expect(context.navigate).toHaveBeenCalledWith("custodian", onboarding);
      } else {
        expect(context.navigate).not.toHaveBeenCalled();
        expect(page.querySelector(".model-setup__verified")).toBeNull();
      }
    },
  );
});
