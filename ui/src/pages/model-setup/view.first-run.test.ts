/* @vitest-environment jsdom */

import { nothing, render } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SystemAgentSetupDetectResult } from "../../api/types.ts";
import { i18n } from "../../i18n/index.ts";
import { mount, props } from "./test-helpers/view.test-support.ts";

const ready: SystemAgentSetupDetectResult = {
  candidates: [],
  unavailableCandidates: [],
  manualProviders: [],
  authOptions: [],
  prepareOptions: [],
  recommendedInstalls: [],
  workspace: "/tmp/workspace",
  configuredModel: "openai/gpt-5",
  setupComplete: true,
};

const firstRunProps = () =>
  props({
    page: { phase: "ready", result: ready },
    firstRun: true,
    manualProviderId: "",
    iconUrls: {},
  });

describe("renderModelSetup first-run continuation", () => {
  beforeEach(async () => {
    await i18n.setLocale("en");
  });

  afterEach(() => {
    for (const container of document.body.querySelectorAll("div")) {
      render(nothing, container);
    }
    document.body.replaceChildren();
  });

  it("keeps durable continuation without duplicating a fresh success action", () => {
    const onOpenChat = vi.fn();
    const container = mount({ ...firstRunProps(), onOpenChat });

    const continueButton = [...container.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "Continue setup",
    );
    expect(continueButton).toBeDefined();
    continueButton?.click();
    expect(onOpenChat).toHaveBeenCalledOnce();

    const freshSuccess = mount({
      ...firstRunProps(),
      activation: { phase: "success", modelRef: "openai/gpt-5" },
    });
    expect(
      [...freshSuccess.querySelectorAll("button")].filter(
        (button) => button.textContent?.trim() === "Continue setup",
      ),
    ).toHaveLength(1);
    expect(freshSuccess.textContent).not.toContain("Open Chat");
  });

  it.each([{ canAdmin: false }, { gatewayTooOld: true }])(
    "keeps continuation available with restricted setup controls",
    (access) => {
      const container = mount({ ...firstRunProps(), ...access });
      expect(container.textContent).toContain("Continue setup");
    },
  );

  it("omits continuation outside first run", () => {
    const container = mount({ ...firstRunProps(), firstRun: false });
    expect(container.textContent).not.toContain("Continue setup");
  });
});
