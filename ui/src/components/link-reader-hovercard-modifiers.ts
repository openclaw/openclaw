import { listen } from "../lib/reactive/listener.ts";

let held = false;
let suppressed = false;
const dismissers = new Set<() => void>();

function update(event: MouseEvent | KeyboardEvent): void {
  held = event.ctrlKey || event.metaKey;
  if (!held) {
    if (event.type === "pointerover") {
      suppressed = false;
    }
    return;
  }
  if (suppressed) {
    return;
  }
  suppressed = true;
  for (const dismiss of dismissers) {
    dismiss();
  }
}

// Document-lifetime input state is shared by lazy activation and mounted providers.
// Pointer input also reconciles keys pressed outside this browser window.
listen(document, "keydown", update, true);
listen(document, "keyup", update, true);
listen(document, "pointerover", update, true);
// Only fresh intent ends suppression; a lazy import finishing after keyup must not reopen it.
listen(
  document,
  "focusin",
  () => {
    if (!held) {
      suppressed = false;
    }
  },
  true,
);
listen(window, "blur", () => {
  held = false;
});

export const linkPreviewModifiers = {
  get suppressed(): boolean {
    return suppressed;
  },
  subscribe(dismiss: () => void): () => void {
    dismissers.add(dismiss);
    return () => {
      dismissers.delete(dismiss);
    };
  },
};
