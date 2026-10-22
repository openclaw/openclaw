/* @vitest-environment jsdom */
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import type { LobsterPetProps } from "../../components/lobster-pet-contract.ts";
import {
  composerContext,
  renderComposer,
  resetComposerTestFixtures,
} from "./composer.test-support.ts";

const visitor = (composer: Element) =>
  composer.querySelector<HTMLElement & LobsterPetProps>("openclaw-lobster-pet")!;

afterEach(() => {
  resetComposerTestFixtures();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("new-session composer critter visits", () => {
  it("keeps visitor preferences and dismissal refresh connected to Appearance", () => {
    const context = composerContext({ client: null });
    context.theme.settings.lobsterPetVisits = false;
    context.theme.settings.lobsterPetSounds = true;
    const { composer, rerender } = renderComposer({ context });
    const pet = visitor(composer);
    expect(pet).toMatchObject({ visitsEnabled: false, soundsEnabled: true });
    context.theme.settings.lobsterPetVisits = true;
    rerender();
    expect(pet.visitsEnabled).toBe(true);
    pet.onVisitsDisabled();
    expect(context.theme.refresh).toHaveBeenCalledOnce();
  });

  it("suspends only the resident for a theme without a mascot and passes its visitor catalog", () => {
    const context = composerContext({ client: null });
    const { composer, rerender } = renderComposer({ context });
    const pet = visitor(composer);
    expect(pet).toMatchObject({ visitsEnabled: true, residentEnabled: true });
    context.theme.branding.mascot = "none";
    context.theme.branding.critters = ["penguin", "fedora"];
    rerender();
    expect(pet).toMatchObject({
      residentEnabled: false,
      visitsEnabled: true,
      critters: ["penguin", "fedora"],
    });
    expect(context.theme.settings.lobsterPetVisits).toBe(true);
    context.theme.branding.mascot = "claw";
    rerender();
    expect(pet).toMatchObject({ residentEnabled: true, visitsEnabled: true });
    context.theme.settings.lobsterPetVisits = false;
    rerender();
    expect(pet.visitsEnabled).toBe(false);
  });

  it("keeps the visitor cast stable while editing and rerolls only for a new draft or opening", () => {
    const first = renderComposer();
    document.body.append(first.container);
    onTestFinished(() => first.container.remove());
    const currentVisitor = () => visitor(first.composer);
    const initial = currentVisitor();
    const seed = initial.seed;
    expect(initial.parentElement?.classList.contains("agent-chat__input")).toBe(true);
    expect(initial.floorEnabled).toBe(true);
    first.rerender();
    first.rerenderForAgent("resolved-agent");
    expect(currentVisitor()).toBe(initial);
    expect(currentVisitor().seed).toBe(seed);
    const textarea = first.composer.querySelector("textarea")!;
    const elements = initial.composerElements!()!;
    expect(elements.composer).toBe(initial.parentElement);
    expect(elements.editor).toBe(textarea);
    expect(elements.footer).toBe(first.composer.querySelector(".agent-chat__composer-footer"));
    expect(elements.controls).toEqual([
      first.composer.querySelector(".agent-chat__composer-lead"),
      first.composer.querySelector(".agent-chat__composer-actions"),
    ]);
    textarea.value = "A prompt takes priority over the visitors";
    textarea.dispatchEvent(new InputEvent("input", { bubbles: true }));
    expect(currentVisitor()).toMatchObject({ seed, floorEnabled: false });
    first.rerenderForDraftRoute("draft:two", "");
    expect(currentVisitor().seed).not.toBe(seed);
    expect(currentVisitor().floorEnabled).toBe(true);
    const reopened = renderComposer();
    expect(visitor(reopened.composer).seed).not.toBe(seed);
  });

  it.each([{ dictationActive: true }, { submitting: true }, { messageLocked: true }])(
    "keeps the critters off the floor while the composer is occupied: %j",
    (state) => {
      const { composer } = renderComposer(state);
      expect(visitor(composer).floorEnabled).toBe(false);
    },
  );
});
