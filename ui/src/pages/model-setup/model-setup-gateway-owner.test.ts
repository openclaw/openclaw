/* @vitest-environment jsdom */
import { expect, it } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayHelloOk } from "../../api/gateway.ts";
import type { WizardNextResult } from "../../api/types.ts";
import { createGatewayStoreTestStore } from "../../app/gateway-store.test-support.ts";
import { loadSettings } from "../../app/settings.ts";
import { sourceConfigSnapshot } from "../../lib/config/config-snapshot.test-support.ts";
import { createRuntimeConfigCapability } from "../../lib/config/runtime-config-capability.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import { persistFirstRunActivationReceipt } from "./first-run-activation-receipt.ts";
import {
  waitForElement,
  waitForText,
  runningStep,
  authButton,
  mockRequests,
  answerWizard,
  authOption,
  activated,
  useFirstRunFixtures,
  pendingReceipt,
  callsFor,
  createFirstRunContext,
  detection,
} from "./model-setup-first-run.test-support.ts";
import {
  createPage,
  mountModelSetupPage,
  unmountModelSetupPage,
} from "./test-helpers/solid-page.test-support.tsx";

useFirstRunFixtures("synthetic-gateway-owner-device-key", false, true);
const ownerChanges = [
  "same target",
  "token change",
  "admin access lost",
  "same-client admin access lost",
  "authenticated owner change",
  "same-client authenticated owner change",
  "authenticated scope missing",
  "authenticated scope missing from start",
  "authenticated owner change with another receipt",
] as const;

it.each(ownerChanges)(
  "real Gateway store: %s preserves or retires the clicked receipt without replay",
  async (change) => {
    const { gateway, current } = createGatewayStoreTestStore({
      settings: {
        ...loadSettings(),
        gatewayUrl: "wss://synthetic-gateway.example.test",
        token: "synthetic-initial-token",
      },
    });
    const fixture = createFirstRunContext();
    const hello = (recoveryScope = "synthetic-owner-a"): GatewayHelloOk => ({
      ...fixture.snapshot.hello,
      auth: {
        ...fixture.snapshot.hello.auth,
        deviceToken: "synthetic-device-grant",
        recoveryScope,
      },
      features: {
        methods: [
          "config.get",
          "config.set",
          "openclaw.setup.detect",
          "openclaw.setup.auth.start",
          "openclaw.setup.verify",
          "wizard.next",
          "wizard.cancel",
        ],
      },
    });
    const originalAnswer = createDeferred<WizardNextResult>();
    const answerStarted = createDeferred();
    const inventory = {
      ...detection,
      authOptions: [authOption("selected-provider", "Selected provider")],
    };
    gateway.start();
    const original = current();
    const sharedResponses = {
      "openclaw.setup.detect": () => inventory,
      "config.get": () => sourceConfigSnapshot({}, "synthetic-config"),
      "wizard.cancel": () => ({ status: "cancelled" }),
    };
    mockRequests(original.request, {
      ...sharedResponses,
      "openclaw.setup.auth.start": () => ({ done: false, status: "running" }),
      "wizard.next": async (params) => {
        if ((params as { answer?: unknown }).answer) {
          answerStarted.resolve();
          return await originalAnswer.promise;
        }
        return runningStep({
          id: "provider-key",
          type: "text",
          message: "Enter selected provider key",
          sensitive: true,
        });
      },
    });
    const initialHello = hello();
    if (change === "authenticated scope missing from start") {
      delete initialHello.auth!.recoveryScope;
    }
    original.testOptions.onHello?.(initialHello);
    const runtimeConfig = createRuntimeConfigCapability(gateway);
    const context = { ...fixture.context, gateway, runtimeConfig };
    const page = createPage(context);
    page.routeData = { firstRun: true };
    document.body.append(page);
    mountModelSetupPage(page);
    try {
      await waitForFast(() => expect(authButton(page, "selected-provider")).not.toBeNull());
      authButton(page, "selected-provider")!.click();
      await waitForElement(page, "#model-setup-wizard-text-input");
      await answerWizard(page, "synthetic-provider-key");
      await answerStarted.promise;
      const receipt = pendingReceipt();
      expect(receipt).not.toBeNull();
      const originalRevision = gateway.connectionRevision;
      const [originalStart] = callsFor(original.request, "openclaw.setup.auth.start");
      const sessionId = (originalStart![1] as { sessionId: string }).sessionId;

      let replacementReceipt: string | null = null;
      if (change === "authenticated owner change with another receipt") {
        persistFirstRunActivationReceipt(context, {
          kind: "provider-auth",
          modelRef: "provider/another-choice",
        });
        replacementReceipt = pendingReceipt();
        expect(replacementReceipt).not.toBe(receipt);
      }
      // Real reconnect callbacks own revision and authority changes.
      if (change.startsWith("same-client")) {
        original.testOptions.onClose?.({
          code: 1006,
          reason: "synthetic reconnect",
          willRetry: true,
        });
      } else {
        gateway.connect(change === "token change" ? { token: "replacement-token" } : {});
      }
      const replacement = current();
      const requestOffset = replacement.request.mock.calls.length;
      const sent = (match: string | RegExp) =>
        replacement.request.mock.calls
          .slice(requestOffset)
          .filter(([method]) =>
            typeof match === "string" ? method === match : match.test(method),
          );
      mockRequests(replacement.request, {
        ...sharedResponses,
        "wizard.next": () =>
          runningStep({
            id: "provider-review",
            type: "confirm",
            message: "Review selected provider",
          }),
      });
      const reconnectedHello = hello(
        change.includes("authenticated owner change") ? "synthetic-owner-b" : undefined,
      );
      if (change.startsWith("authenticated scope missing")) {
        delete reconnectedHello.auth!.recoveryScope;
      }
      const authorityLost = change.includes("admin access lost");
      if (authorityLost) {
        reconnectedHello.auth!.scopes = ["operator.read"];
        replacementReceipt = receipt;
      }
      replacement.testOptions.onHello?.(reconnectedHello);
      expect(gateway.connectionRevision).toBe(
        originalRevision + (change === "token change" ? 1 : 0),
      );

      if (change === "same target") {
        await waitForText(page, "Review selected provider");
        expect(pendingReceipt()).toBe(receipt);
        expect(sent("wizard.next").map(([, params]) => params)).toEqual([{ sessionId }]);
        expect(callsFor(original.request, "wizard.cancel")).toHaveLength(0);
      } else {
        await waitForFast(() => expect(page.querySelector("openclaw-modal-dialog")).toBeNull());
        expect(sent(/^wizard\./u)).toHaveLength(0);
        expect(pendingReceipt()).toBe(replacementReceipt);
        if (authorityLost) {
          expect(page.textContent).toContain("operator.admin");
          expect(sent(/^openclaw\.setup\./u)).toHaveLength(0);
        }
      }
      originalAnswer.resolve(activated("provider/original"));
      await waitForFast(() =>
        expect(
          original.request.mock.settledResults.filter((result) => result.type === "incomplete"),
        ).toHaveLength(0),
      );
      if (authorityLost) {
        // Reauthorization must not revive a discarded wizard or replay its answer.
        replacement.testOptions.onHello?.(hello());
        await waitForElement(page, ".model-setup__recovery");
        expect(page.querySelector("openclaw-modal-dialog")).toBeNull();
        expect(sent(/^wizard\./u)).toHaveLength(0);
      }
      if (change !== "same target") {
        expect(pendingReceipt()).toBe(replacementReceipt);
      }
      expect(context.navigate).not.toHaveBeenCalled();
      expect(callsFor(original.request, "openclaw.setup.auth.start")).toHaveLength(1);
      expect(sent("openclaw.setup.auth.start")).toHaveLength(0);
      expect(
        original.request.mock.calls.filter(
          ([method, params]) =>
            method === "wizard.next" && Boolean((params as { answer?: unknown }).answer),
        ),
      ).toHaveLength(1);
    } finally {
      originalAnswer.resolve({ done: true, status: "cancelled" });
      unmountModelSetupPage(page);
      page.remove();
      runtimeConfig.dispose();
      fixture.context.runtimeConfig.dispose();
      gateway.stop();
    }
  },
);
