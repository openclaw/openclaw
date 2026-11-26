import { createComponent } from "solid-js";
import { assert, vi } from "vitest";
import { projectOwner } from "../../lib/reactive/projection.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { renderComposerVoiceButtonSolid } from "./components/chat-composer-controls.tsx";
import type { ComposerDictationOwner } from "./composer-dictation.ts";

// The real button's click routing differs from controller-only harnesses during dictation.
export function mountComposerDictationButton(
  controller: ComposerDictationOwner,
): HTMLButtonElement {
  const container = document.createElement("div");
  document.body.append(container);
  mountSolid(
    () => {
      const owner = projectOwner(controller, (value) => value);
      return createComponent(renderComposerVoiceButtonSolid, {
        connected: true,
        readDictation: owner.read,
        onDictationPointerDown: (event) => controller.handlePointerDown(event),
        onToggleVoice: vi.fn(),
      });
    },
    { container },
  );
  const target = container.querySelector("button");
  assert.isNotNull(target);
  return target;
}
