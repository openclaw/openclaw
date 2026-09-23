/* @vitest-environment jsdom */
import { afterEach, expect, it, vi } from "vitest";
import { choosePickerValue, updatePickers } from "../../test-helpers/select-picker.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import { appendPage, createHarness } from "./model-providers-page.test-support.ts";
afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});
it("preserves defaults published while a decision connection is awaiting confirmation", async () => {
  const { context, request } = createHarness("writer");
  const original = request.getMockImplementation()!;
  let configured = false;
  let thinking = "low";
  let revision = 1;
  request.mockImplementation(async (method: string) => {
    if (method === "config.get") {
      const config = {
        agents: { defaults: { thinkingDefault: thinking }, entries: { writer: {} } },
      };
      return {
        config,
        sourceConfig: config,
        raw: JSON.stringify(config),
        hash: String(revision),
        valid: true,
      };
    }
    if (method === "models.list") {
      return {
        models: [],
        decisionModels: [
          {
            provider: "fixture",
            id: "decision",
            name: "Decision",
            pluginId: "fixture",
            readiness: configured ? "configured" : "setup-required",
            setup: {
              kind: "api-key",
              label: "Fixture",
              help: "Add a key",
              credentialPath: ["plugins", "entries", "fixture", "config", "key"],
            },
          },
        ],
      };
    }
    if (method === "plugins.credentials.set") {
      configured = true;
      return { saved: true };
    }
    return original(method);
  });
  const page = appendPage(context);
  await waitForFast(() => expect(page.data?.updatedAt).toEqual(expect.any(Number)));
  await updatePickers(page);
  await choosePickerValue(
    page.querySelector<HTMLButtonElement>("#model-providers-decision-model")!,
    "fixture/decision",
  );
  await page.updateComplete;
  const button = (name: string) =>
    [...page.querySelectorAll<HTMLButtonElement>("[data-models-key-dialog] button")].find(
      (candidate) => candidate.textContent?.trim() === name,
    )!;
  const input = page.querySelector<HTMLInputElement>("[data-models-key-dialog] input")!;
  input.value = "synthetic-input";
  input.dispatchEvent(new Event("input", { bubbles: true }));
  await page.updateComplete;
  button("Connect Fixture").click();
  await waitForFast(() => expect(button("Use Decision")).toBeDefined());
  thinking = "high";
  revision++;
  await context.runtimeConfig.refresh();
  await page.updateComplete;
  button("Use Decision").click();
  await waitForFast(() =>
    expect(context.runtimeConfig.patch).toHaveBeenCalledWith(
      expect.objectContaining({
        raw: expect.objectContaining({
          agents: expect.objectContaining({
            defaults: expect.objectContaining({
              thinkingDefault: "high",
              decisionModel: "fixture/decision",
            }),
          }),
        }),
      }),
    ),
  );
});
