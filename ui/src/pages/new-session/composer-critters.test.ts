/* @vitest-environment jsdom */
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  installComposerDecorationProbe,
  type ComposerDecorationProbe,
} from "../../test-helpers/control-ui-accessory-fixture.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import {
  composerContext,
  renderComposer as renderBaseComposer,
  resetComposerTestFixtures,
} from "./composer.test-support.ts";

const visitorElement = (composer: Element) =>
  composer.querySelector<ComposerDecorationProbe>("[data-composer-decoration-probe]");
const visitor = (composer: Element) => visitorElement(composer)?.value;
function renderComposer(options: Parameters<typeof renderBaseComposer>[0] = {}) {
  const context = options.context ?? composerContext({ client: null });
  installComposerDecorationProbe(context);
  return renderBaseComposer({ ...options, context });
}

let idleCallbacks: IdleRequestCallback[];
beforeEach(() => {
  idleCallbacks = [];
  vi.stubGlobal("requestIdleCallback", (callback: IdleRequestCallback) => {
    idleCallbacks.push(callback);
    return idleCallbacks.length;
  });
});

function waitForVisitor(composer: Element) {
  return waitForSolid(() => expectDefined(visitor(composer), "mounted visitor probe"));
}

async function loadPet(composer: Element) {
  await waitForSolid(() => expect(idleCallbacks.length).toBeGreaterThan(0));
  for (const callback of idleCallbacks.splice(0)) {
    callback({ didTimeout: false, timeRemaining: () => 50 });
  }
  return waitForVisitor(composer);
}

afterEach(() => {
  resetComposerTestFixtures();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("new-session composer critter visits", () => {
  it("keeps the composer editable before idle and renders warm pets without waiting again", async () => {
    const { composer, unmount } = renderComposer();
    expect(visitor(composer)).toBeUndefined();
    const input = composer.querySelector("textarea")!;
    input.value = "Typed before idle";
    input.dispatchEvent(new InputEvent("input", { bubbles: true }));
    expect(input.value).toBe("Typed before idle");
    expect(input.disabled).toBe(false);
    const pet = await loadPet(composer);
    expect(pet.floorEnabled).toBe(false);
    expect(composer.querySelector("textarea")).toBe(input);
    unmount();
    const reopened = renderComposer();
    const nextPet = await waitForVisitor(reopened.composer);
    expect(nextPet.identity).not.toBe(pet.identity);
  });

  it("keeps visitor preferences and dismissal refresh connected to Appearance", async () => {
    const context = composerContext({ client: null });
    context.theme.settings.lobsterPetVisits = false;
    context.theme.settings.lobsterPetSounds = true;
    const { composer, rerender } = renderComposer({ context });
    const pet = await loadPet(composer);
    expect(pet).toMatchObject({ visitsEnabled: false, soundsEnabled: true });
    context.theme.settings.lobsterPetVisits = true;
    rerender();
    const enabled = await waitForSolid(() => {
      const probe = expectDefined(visitor(composer), "mounted visitor probe");
      expect(probe.visitsEnabled).toBe(true);
      return probe;
    });
    enabled.onVisitsDisabled();
    expect(context.theme.refresh).toHaveBeenCalledOnce();
  });

  it("leaves mascot policy in the plugin and preserves browser visit preferences across theme changes", async () => {
    const context = composerContext({ client: null });
    const { composer, rerender } = renderComposer({ context });
    await loadPet(composer);
    context.theme.branding.mascot = "none";
    context.theme.branding.critters = ["penguin", "fedora"];
    rerender();
    await waitForSolid(() => expect(visitor(composer)?.visitsEnabled).toBe(true));
    expect(context.theme.settings.lobsterPetVisits).toBe(true);
    context.theme.settings.lobsterPetVisits = false;
    rerender();
    await waitForSolid(() => expect(visitor(composer)?.visitsEnabled).toBe(false));
  });

  it("keeps the visitor cast stable while editing and rerolls only for a new draft or opening", async () => {
    const first = renderComposer();

    const currentVisitor = () => expectDefined(visitor(first.composer), "mounted visitor probe");
    const initial = await loadPet(first.composer);
    const seed = initial.identity;
    const element = visitorElement(first.composer)!;
    expect(element.closest(".agent-chat__input")).not.toBeNull();
    expect(initial.floorEnabled).toBe(true);
    first.rerender();
    first.rerenderForAgent("resolved-agent");
    expect(visitorElement(first.composer)).toBe(element);
    expect(currentVisitor().identity).toBe(seed);
    const textarea = first.composer.querySelector("textarea")!;
    const elements = initial.composerElements!()!;
    expect(elements.composer).toBe(element.closest(".agent-chat__input"));
    expect(elements.editor).toBe(textarea);
    expect(elements.footer).toBe(first.composer.querySelector(".agent-chat__composer-footer"));
    expect(elements.controls).toEqual([
      first.composer.querySelector(".agent-chat__composer-lead"),
      first.composer.querySelector(".agent-chat__composer-actions"),
    ]);
    textarea.value = "A prompt takes priority over the visitors";
    textarea.dispatchEvent(new InputEvent("input", { bubbles: true }));
    await waitForSolid(() =>
      expect(currentVisitor()).toMatchObject({ identity: seed, floorEnabled: false }),
    );
    first.rerenderForDraftRoute("draft:two", "");
    await waitForSolid(() => {
      const replacement = currentVisitor();
      expect(replacement.identity).not.toBe(seed);
      expect(replacement.floorEnabled).toBe(true);
    });
    const reopened = renderComposer();
    expect((await loadPet(reopened.composer)).identity).not.toBe(seed);
  });

  it.each([{ dictationActive: true }, { submitting: true }, { messageLocked: true }])(
    "keeps the critters off the floor while the composer is occupied: %j",
    async (state) => {
      const { composer } = renderComposer(state);
      expect((await loadPet(composer)).floorEnabled).toBe(false);
    },
  );
});
