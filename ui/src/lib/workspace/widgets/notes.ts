import { html, type TemplateResult } from "lit";
import { ref } from "lit/directives/ref.js";
import { t } from "../../../i18n/index.ts";
import type { WorkspaceWidget } from "../types.ts";
import type { BuiltinWidgetContext, BuiltinWidgetState } from "./types.ts";
import { widgetProps } from "./types.ts";

const NOTES_PERSIST_DEBOUNCE_MS = 500;

function seedText(widget: WorkspaceWidget): string {
  const text = widgetProps(widget).text;
  return typeof text === "string" ? text : "";
}

function isConflict(error: unknown): boolean {
  return error instanceof Error && /version conflict/i.test(error.message);
}

const editorBindings = new WeakMap<BuiltinWidgetState, (element: Element | undefined) => void>();

function bindEditor(state: BuiltinWidgetState): (element: Element | undefined) => void {
  const existing = editorBindings.get(state);
  if (existing) {
    return existing;
  }
  let textarea: HTMLTextAreaElement | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let dirty = false;
  let disconnected = false;
  let disconnectRevision = 0;
  let saving = false;
  let queued = false;
  let latest = "";
  let version: number | undefined;
  let hydrationPending = true;
  let hydrationStarted = false;

  const showStatus = (key: "saveError" | "conflict" | null): void => {
    const status = textarea?.parentElement?.querySelector<HTMLElement>(
      "[data-test-id='workspace-notes-status']",
    );
    if (!status) {
      return;
    }
    status.dataset.state = key ? "error" : "idle";
    status.textContent =
      key === "conflict"
        ? t("workspaces.widget.notes.conflict")
        : key === "saveError"
          ? t("workspaces.widget.notes.saveError")
          : "";
  };

  const persist = async (): Promise<void> => {
    timer = undefined;
    if (disconnected) {
      return;
    }
    if (saving) {
      queued = true;
      return;
    }
    if (version === undefined) {
      if (hydrationPending) {
        queued = true;
        return;
      }
      showStatus("saveError");
      return;
    }
    saving = true;
    queued = false;
    const value = latest;
    try {
      const result = await state.set(value, version);
      version = result.version;
      if (latest === value) {
        dirty = false;
      }
      showStatus(null);
    } catch (error) {
      showStatus(isConflict(error) ? "conflict" : "saveError");
    } finally {
      saving = false;
      if (!disconnected && queued && latest !== value) {
        void persist();
      }
    }
  };

  const onInput = (): void => {
    if (!textarea) {
      return;
    }
    dirty = true;
    latest = textarea.value;
    showStatus(null);
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    timer = setTimeout(() => void persist(), NOTES_PERSIST_DEBOUNCE_MS);
  };

  const binding = (element: Element | undefined): void => {
    if (!(element instanceof HTMLTextAreaElement)) {
      disconnected = true;
      const revision = ++disconnectRevision;
      queueMicrotask(() => {
        if (!disconnected || revision !== disconnectRevision) {
          return;
        }
        if (timer !== undefined) {
          clearTimeout(timer);
          timer = undefined;
        }
        queued ||= dirty;
        textarea?.removeEventListener("input", onInput);
        textarea = null;
      });
      return;
    }
    disconnected = false;
    disconnectRevision += 1;
    if (textarea === element) {
      return;
    }
    textarea?.removeEventListener("input", onInput);
    textarea = element;
    if (dirty) {
      element.value = latest;
    } else {
      latest = element.value;
    }
    element.addEventListener("input", onInput);
    if (version !== undefined) {
      if (dirty && queued && timer === undefined && !saving) {
        timer = setTimeout(() => void persist(), NOTES_PERSIST_DEBOUNCE_MS);
      }
      return;
    }
    if (hydrationStarted) {
      return;
    }
    hydrationStarted = true;
    hydrationPending = true;
    void state
      .get()
      .then((result) => {
        hydrationPending = false;
        if (disconnected) {
          hydrationStarted = false;
          return;
        }
        version = result.version;
        if (!dirty && typeof result.state === "string" && textarea) {
          textarea.value = result.state;
          latest = result.state;
        }
        if (dirty && queued) {
          void persist();
        }
      })
      .catch(() => {
        hydrationPending = false;
        hydrationStarted = false;
        if (dirty) {
          showStatus("saveError");
        }
      });
  };
  editorBindings.set(state, binding);
  return binding;
}

export function renderNotes(
  widget: WorkspaceWidget,
  _value: unknown,
  context: BuiltinWidgetContext,
): TemplateResult {
  const seed = seedText(widget);
  const status = context.state ? "" : t("workspaces.widget.notes.readonlyHint");
  return html`
    <div class="workspace-notes" data-test-id="workspace-notes">
      <textarea
        class="workspace-notes__pad"
        data-test-id="workspace-notes-pad"
        aria-label=${widget.title ?? t("workspaces.widget.notes.placeholder")}
        placeholder=${t("workspaces.widget.notes.placeholder")}
        ?readonly=${!context.state}
        .value=${seed}
        ${context.state ? ref(bindEditor(context.state)) : null}
      ></textarea>
      <div
        class="workspace-notes__status"
        data-test-id="workspace-notes-status"
        data-state=${context.state ? "idle" : "readonly"}
        role=${context.state ? "alert" : "status"}
      >
        ${status}
      </div>
    </div>
  `;
}
