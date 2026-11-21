import type { PanzoomObject } from "@panzoom/panzoom";
import {
  KEYBOARD_SHORTCUT_COMBOS,
  matchesShortcutCombo,
} from "../lib/keyboard-shortcut-contract.ts";

const PAN_STEP_PX = 48;
const PAN_DIRECTIONS = [
  { combo: KEYBOARD_SHORTCUT_COMBOS.imagePanLeft, x: -1, y: 0 },
  { combo: KEYBOARD_SHORTCUT_COMBOS.imagePanRight, x: 1, y: 0 },
  { combo: KEYBOARD_SHORTCUT_COMBOS.imagePanUp, x: 0, y: -1 },
  { combo: KEYBOARD_SHORTCUT_COMBOS.imagePanDown, x: 0, y: 1 },
] as const;

export function panImageWithKeyboard(event: KeyboardEvent, panzoom?: PanzoomObject): boolean {
  const pan = PAN_DIRECTIONS.find(({ combo }) => matchesShortcutCombo(combo, event));
  if (!pan) {
    return false;
  }
  const scale = panzoom?.getScale() ?? 1;
  if (panzoom && scale > 1) {
    event.preventDefault();
    event.stopPropagation();
    // Panzoom scales translations, so keep each key press the same screen distance.
    const step = PAN_STEP_PX / scale;
    panzoom.pan(pan.x * step, pan.y * step, { relative: true, animate: false });
  }
  return true;
}
