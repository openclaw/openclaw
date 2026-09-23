import { html, nothing, type TemplateResult } from "lit";
import { AsyncDirective } from "lit/async-directive.js";
import { directive, type ElementPart } from "lit/directive.js";
import { ref } from "lit/directives/ref.js";

export const COMMAND_PALETTE_INPUT_ID = "cmd-palette-input";

type CommandPaletteInputProps = {
  value: string;
  placeholder: string;
  onInputRef: (element: Element | undefined) => void;
  onValueChange: (value: string, event: InputEvent) => void;
  onBeforeInput?: (event: InputEvent) => void;
  onSelectionChange?: (event: Event) => void;
  onCompositionStart?: () => void;
  onCompositionEnd?: () => void;
  actions?: TemplateResult | typeof nothing;
  onPaste?: (event: ClipboardEvent) => void;
  disabled?: boolean;
  readOnly?: boolean;
  controls?: string;
  activeDescendant?: string;
  describedBy?: string;
};

function updatePaletteInputOverflow(textarea: HTMLTextAreaElement) {
  const root = textarea.closest(".cmd-palette__entry");
  const overflow = textarea.scrollHeight - textarea.clientHeight;
  root?.toggleAttribute("data-scroll-fade-top", overflow > 1 && textarea.scrollTop > 1);
  root?.toggleAttribute(
    "data-scroll-fade-bottom",
    overflow > 1 && textarea.scrollTop < overflow - 1,
  );
}

// This input is also the cold-loader surface. Keep its DOM/layout owner free of
// search catalogs, draft creation, and the full chat composer's scroll lifecycle.
function updatePaletteInputLayout(textarea: HTMLTextAreaElement, editing = false) {
  const root = textarea.closest<HTMLElement>(".cmd-palette__entry");
  const actions = root?.querySelector<HTMLElement>(".cmd-palette__input-actions");
  if (root && actions) {
    root.style.setProperty(
      "--cmd-palette-actions-width",
      `${actions.getBoundingClientRect().width}px`,
    );
  }
  const lineHeight = Number.parseFloat(getComputedStyle(textarea).lineHeight);
  if (!Number.isFinite(lineHeight) || lineHeight <= 0) {
    return;
  }
  const previousScroll = textarea.scrollTop;
  // A caret at the end does not imply follow intent after manual scrolling.
  // Only input edits reveal it; rerenders and resizes preserve the viewport.
  const followCaret =
    editing &&
    document.activeElement === textarea &&
    textarea.selectionStart === textarea.selectionEnd &&
    textarea.selectionEnd === textarea.value.length;
  textarea.style.overflowY = "hidden";
  textarea.style.height = "0px";
  textarea.style.height = `${Math.max(lineHeight, Math.min(lineHeight * 3, textarea.scrollHeight))}px`;
  const overflowing = textarea.scrollHeight > textarea.clientHeight + 1;
  textarea.style.overflowY = overflowing ? "auto" : "hidden";
  textarea.scrollTop = overflowing ? (followCaret ? textarea.scrollHeight : previousScroll) : 0;
  updatePaletteInputOverflow(textarea);
}

function handlePaletteInputScroll(event: Event) {
  const textarea = event.currentTarget;
  if (textarea instanceof HTMLTextAreaElement && textarea.isConnected) {
    updatePaletteInputOverflow(textarea);
  }
}

class PaletteInputLayoutDirective extends AsyncDirective {
  #textarea: HTMLTextAreaElement | undefined;
  #observer: ResizeObserver | undefined;
  #frame: number | undefined;

  render(_value: string) {
    return nothing;
  }

  override update(part: ElementPart, [_value]: [string]) {
    this.#textarea = part.element instanceof HTMLTextAreaElement ? part.element : undefined;
    this.#scheduleLayout();
    return nothing;
  }

  readonly #scheduleLayout = () => {
    if (this.#frame !== undefined) {
      return;
    }
    this.#frame = requestAnimationFrame(() => {
      this.#frame = undefined;
      const textarea = this.#textarea;
      if (!this.isConnected || !textarea?.isConnected) {
        return;
      }
      if (!this.#observer && typeof ResizeObserver === "function") {
        // Observe once per connected lifetime. Lit owns the field's scroll
        // listener; this directive owns only resize observation and layout work.
        this.#observer = new ResizeObserver(this.#scheduleLayout);
        const root = textarea.closest(".cmd-palette__entry");
        if (root) {
          this.#observer.observe(root);
          const actions = root.querySelector(".cmd-palette__input-actions");
          if (actions) {
            this.#observer.observe(actions);
          }
        }
      }
      updatePaletteInputLayout(textarea);
    });
  };

  protected override disconnected() {
    this.#observer?.disconnect();
    this.#observer = undefined;
    if (this.#frame !== undefined) {
      cancelAnimationFrame(this.#frame);
      this.#frame = undefined;
    }
  }

  protected override reconnected() {
    this.#scheduleLayout();
  }
}

const paletteInputLayout = directive(PaletteInputLayoutDirective);

export function renderCommandPaletteInput(props: CommandPaletteInputProps) {
  return html`
    <div class="cmd-palette__entry">
      <div class="cmd-palette__input-scroll">
        <textarea
          ${paletteInputLayout(props.value)}
          autofocus
          rows="1"
          id=${COMMAND_PALETTE_INPUT_ID}
          class="cmd-palette__input"
          aria-label=${props.placeholder}
          aria-autocomplete=${props.controls ? "list" : nothing}
          aria-haspopup=${props.controls ? "listbox" : nothing}
          aria-controls=${props.controls ?? nothing}
          aria-activedescendant=${props.activeDescendant ?? nothing}
          aria-describedby=${props.describedBy ?? nothing}
          placeholder=${props.placeholder}
          .value=${props.value}
          ?disabled=${props.disabled}
          ?readonly=${props.readOnly}
          @scroll=${handlePaletteInputScroll}
          @paste=${props.onPaste ?? nothing}
          @beforeinput=${props.onBeforeInput ?? nothing}
          @select=${props.onSelectionChange ?? nothing}
          @pointerup=${props.onSelectionChange ?? nothing}
          @keyup=${(event: KeyboardEvent) => {
            if (event.key.startsWith("Arrow") || event.key === "Home" || event.key === "End") {
              props.onSelectionChange?.(event);
            }
          }}
          @compositionstart=${props.onCompositionStart ?? nothing}
          @compositionend=${props.onCompositionEnd ?? nothing}
          ${ref(props.onInputRef)}
          @input=${(event: InputEvent) => {
            if (event.currentTarget instanceof HTMLTextAreaElement) {
              props.onValueChange(event.currentTarget.value, event);
              updatePaletteInputLayout(event.currentTarget, true);
            }
          }}
        ></textarea>
      </div>
      <div class="cmd-palette__input-actions">${props.actions ?? nothing}</div>
    </div>
  `;
}
