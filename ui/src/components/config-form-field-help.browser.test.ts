// Control UI tests cover the generated row's one-line summary and its on-demand help.
import { afterEach, describe, expect, it, vi } from "vitest";
import { expectElement, renderAnalyzedFormFixture } from "../test-helpers/config-form-fixtures.tsx";
import { analyzeConfigSchema } from "./config-form.analyze.ts";
import type { JsonSchema } from "./config-form.shared.ts";

const LONG_HELP =
  "Queue mode for active runs. Use steer to inject prompts into the active run, or collect to batch them.";

let container: HTMLElement;

function render(properties: Record<string, JsonSchema>, value: Record<string, unknown> = {}) {
  container = document.createElement("div");
  document.body.append(container);
  const onPatch = vi.fn();
  renderAnalyzedFormFixture(
    container,
    analyzeConfigSchema({
      type: "object",
      properties: { lab: { type: "object", properties } },
    }),
    { value: { lab: value }, onPatch },
  );
  return onPatch;
}

function helpButton(label: string) {
  return expectElement(
    container.querySelector<HTMLButtonElement>(`button[aria-label="Help for ${label}"]`),
    `help for ${label}`,
  );
}

async function openHelp(label: string) {
  const button = helpButton(label);
  button.click();
  return await vi.waitFor(() =>
    expectElement(
      document.querySelector<HTMLElement>(
        `[id="${button.getAttribute("aria-controls")}"] .settings-section__help-panel`,
      ),
      `help panel for ${label}`,
    ),
  );
}

afterEach(() => {
  container?.remove();
});

describe("config field help", () => {
  it("shows one sentence in the row and every word on demand", async () => {
    render({ mode: { type: "string", title: "Mode", description: LONG_HELP } });
    expect(container.querySelector(".settings-row__desc")?.textContent?.trim()).toBe(
      "Queue mode for active runs.",
    );
    expect(container.textContent).not.toContain("Use steer");
    expect((await openHelp("Mode")).textContent).toBe(LONG_HELP);
  });

  it("offers nothing more when the row already shows all of it", () => {
    render({ mode: { type: "string", title: "Mode", description: "Queue mode for runs." } });
    expect(container.querySelector(".settings-row__desc")?.textContent?.trim()).toBe(
      "Queue mode for runs.",
    );
    expect(container.querySelector(".config-field-help")).toBeNull();
  });

  it("keeps the default on demand instead of in the row", async () => {
    render({
      retries: {
        type: "integer",
        title: "Retries",
        default: 3,
        description: "Controls retry attempts.",
      },
    });
    expect(container.querySelector(".settings-row__desc")?.textContent?.trim()).toBe(
      "Controls retry attempts.",
    );
    expect((await openHelp("Retries")).textContent).toBe("Controls retry attempts.Default: 3");
  });

  it.each([
    [
      "JSON",
      {
        anyOf: [{ type: "object" }, { type: "array" }],
        title: "Shape",
        default: { mode: "a" },
      },
      'Default: {"mode":"a"}',
    ],
    [
      "list",
      { type: "array", title: "Shape", default: ["a", "b"], items: { type: "string" } },
      'Default: ["a","b"]',
    ],
  ] as const)("offers a %s default on demand", async (_kind, schema, expected) => {
    render({ shape: schema as JsonSchema });
    expect((await openHelp("Shape")).textContent).toBe(expected);
  });

  it("does not change a toggle when its help opens", async () => {
    const onPatch = render({
      enabled: { type: "boolean", title: "Enabled", description: LONG_HELP },
    });
    const panel = await openHelp("Enabled");
    expect(panel.textContent).toBe(LONG_HELP);
    panel.click();
    expect(onPatch).not.toHaveBeenCalled();
    expect(expectElement(container.querySelector("input"), "toggle").checked).toBe(false);
  });

  it("does not open a nested object when its help opens", async () => {
    render({
      sibling: { type: "string", title: "Sibling" },
      nested: {
        type: "object",
        title: "Nested",
        description: LONG_HELP,
        properties: {
          first: { type: "string", title: "First" },
          second: { type: "string", title: "Second" },
        },
      },
    });
    const details = expectElement(container.querySelector("details.cfg-object"), "nested object");
    const wasOpen = details.hasAttribute("open");
    await openHelp("Nested");
    expect(details.hasAttribute("open")).toBe(wasOpen);
  });

  it("closes on Escape and returns focus to its button", async () => {
    render({ mode: { type: "string", title: "Mode", description: LONG_HELP } });
    const panel = await openHelp("Mode");
    const button = helpButton("Mode");
    const popover = expectElement(panel.closest<HTMLElement>('[role="dialog"]'), "help popover");
    expect(popover.dataset.placement).toBe("top-start");
    const hidden = new Promise<void>((resolve) => {
      popover.addEventListener("overlay-after-hide", () => resolve(), { once: true });
    });
    const { userEvent } = await import("vitest/browser");
    button.focus();
    await userEvent.keyboard("{Escape}");
    await hidden;
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(button);
  });
});
