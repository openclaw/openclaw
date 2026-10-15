import { html, render, type LitElement } from "lit";
import { expect, it, vi } from "vitest";
import type { SettingsSaveIndicatorProps } from "./settings-save-indicator.tsx";
import "./settings-save-indicator.tsx";
import startupStyles from "../styles.css?inline";

it("animates Applying before lazy settings styles load", async () => {
  const container = document.createElement("div");
  // Keep lazy route keyframes from masking a missing startup animation owner.
  const root = container.attachShadow({ mode: "open" });
  document.body.append(container);
  try {
    render(
      html`<style>
          ${startupStyles}
        </style>
        <openclaw-settings-save-indicator
          .props=${
            {
              status: "idle",
              lastError: null,
              needsApply: true,
              applying: true,
              applyDisabled: false,
              onRetry: vi.fn(),
              onSave: vi.fn(),
              onReload: vi.fn(),
              onApply: vi.fn(),
            } satisfies SettingsSaveIndicatorProps
          }
        ></openclaw-settings-save-indicator>`,
      root,
    );
    const indicator = root.querySelector<LitElement>("openclaw-settings-save-indicator")!;
    await indicator.updateComplete;
    const spinner = indicator.querySelector<SVGElement>(".settings-save-indicator__spinner svg")!;
    const animations = spinner.getAnimations();
    expect(animations.length).toBeGreaterThan(0);
    const animation = animations[0]!;
    const duration = Number(animation.effect!.getComputedTiming().duration);
    expect(duration).toBeGreaterThan(0);
    animation.pause();
    animation.currentTime = duration / 4;
    const transform = new DOMMatrixReadOnly(getComputedStyle(spinner).transform);
    expect(transform.a).toBeCloseTo(0);
    expect(transform.b).toBeCloseTo(1);
  } finally {
    render(null, root);
    container.remove();
  }
});
