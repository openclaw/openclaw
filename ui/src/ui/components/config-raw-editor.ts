import { indentWithTab } from "@codemirror/commands";
import { EditorState, type Extension, Compartment } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { basicSetup } from "codemirror";
import { LitElement, css, html, nothing } from "lit";
import { customElement, property, query, state } from "lit/decorators.js";
import { I18nController } from "../../i18n/lib/lit-controller.ts";
import { t } from "../../i18n/lib/translate.ts";
import { resolveJson5BreadcrumbsAt, type JsonPathBreadcrumb } from "./config-raw-editor-path.ts";

const rawEditorTheme = EditorView.theme({
  "&": {
    height: "100%",
    minHeight: "520px",
    color: "var(--text)",
    backgroundColor: "transparent",
  },
  ".cm-scroller": {
    fontFamily: "var(--mono)",
    fontSize: "13px",
    lineHeight: "1.55",
    overflow: "auto",
    scrollbarWidth: "thin",
    scrollbarColor: "var(--border) transparent",
  },
  ".cm-content": {
    padding: "14px 0",
    minWidth: "fit-content",
  },
  ".cm-line": {
    padding: "0 16px",
  },
  ".cm-gutters": {
    minWidth: "52px",
    color: "var(--muted)",
    backgroundColor: "transparent",
    borderRight: "1px solid var(--border)",
  },
  ".cm-activeLine": {
    backgroundColor: "color-mix(in srgb, var(--accent-subtle) 55%, transparent)",
  },
  ".cm-activeLineGutter": {
    color: "var(--text)",
    backgroundColor: "color-mix(in srgb, var(--accent-subtle) 45%, transparent)",
  },
  ".cm-selectionBackground, ::selection": {
    backgroundColor: "color-mix(in srgb, var(--accent) 24%, transparent)",
  },
  ".cm-cursor, .cm-dropCursor": {
    borderLeftColor: "var(--accent)",
  },
  ".cm-focused": {
    outline: "none",
  },
  ".cm-matchingBracket": {
    color: "var(--text)",
    backgroundColor: "color-mix(in srgb, var(--accent-subtle) 70%, transparent)",
    outline: "1px solid color-mix(in srgb, var(--accent) 45%, transparent)",
    borderRadius: "3px",
  },
  ".cm-nonmatchingBracket": {
    color: "var(--danger, #ff6b6b)",
    outline: "1px solid color-mix(in srgb, var(--danger, #ff6b6b) 40%, transparent)",
    borderRadius: "3px",
  },
});

@customElement("config-raw-editor")
export class ConfigRawEditor extends LitElement {
  @property() value = "";
  @property({ type: Boolean, reflect: true }) disabled = false;

  @state() private cursorLine = 1;
  @state() private cursorColumn = 1;
  @state() private cursorBreadcrumbs: JsonPathBreadcrumb[] = [];
  @state() private selectionChars = 0;

  @query("[data-editor-root]") private editorRoot!: HTMLDivElement;

  private readonly i18n = new I18nController(this);
  private editorView: EditorView | null = null;
  private syncingFromEditor = false;
  private editableCompartment = new Compartment();
  private readOnlyCompartment = new Compartment();

  static styles = css`
    :host {
      display: block;
      height: min(72vh, 720px);
      min-height: 520px;
    }

    .frame {
      display: grid;
      grid-template-rows: minmax(0, 1fr) auto;
      height: 100%;
      min-height: 0;
      overflow: hidden;
    }

    .status {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 10px 14px;
      border-top: 1px solid var(--border);
      background: transparent;
      color: var(--muted);
      font-family: var(--mono);
      font-size: 12px;
      letter-spacing: 0.01em;
    }

    .status__meta {
      display: flex;
      align-items: center;
      gap: 12px;
      flex-wrap: wrap;
    }

    .status__sep {
      color: var(--muted-strong);
    }

    .status__path {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      flex-wrap: wrap;
    }

    .status__path-btn {
      padding: 0;
      border: 0;
      background: transparent;
      color: inherit;
      font: inherit;
      cursor: pointer;
      text-decoration: none;
    }

    .status__path-btn:hover {
      color: var(--text);
      text-decoration: underline;
    }

    :host([disabled]) .frame {
      opacity: 0.72;
    }

    .editor-root {
      min-height: 0;
      min-width: 0;
    }

    .frame ::-webkit-scrollbar {
      width: 8px;
      height: 8px;
    }

    .frame ::-webkit-scrollbar-track {
      background: transparent;
    }

    .frame ::-webkit-scrollbar-thumb {
      background: var(--border);
      border-radius: var(--radius-full);
    }

    .frame ::-webkit-scrollbar-thumb:hover {
      background: var(--border-strong);
    }
  `;

  render() {
    const lineColLabel = t("config.rawEditor.lineCol", {
      line: String(this.cursorLine),
      col: String(this.cursorColumn),
    });
    const selectionLabel =
      this.selectionChars > 0
        ? t("config.rawEditor.selected", { count: String(this.selectionChars) })
        : t("config.rawEditor.noSelection");

    return html`
      <div class="frame">
        <div class="editor-root" data-editor-root></div>
        <div class="status" aria-live="polite">
          <div class="status__meta">
            <span>${lineColLabel}</span>
            <span class="status__sep">|</span>
            <span class="status__path">
              <span>${t("config.rawEditor.path")}</span>
              ${
                this.cursorBreadcrumbs.length === 0
                  ? html`<span>${t("config.rawEditor.root")}</span>`
                  : this.cursorBreadcrumbs.map(
                      (entry, index) => html`
                        <button
                          class="status__path-btn"
                          type="button"
                          @click=${() => this.setSelection(entry.from)}
                        >
                          ${
                            typeof entry.segment === "number" ? `[${entry.segment}]` : entry.segment
                          }
                        </button>
                        ${
                          index < this.cursorBreadcrumbs.length - 1
                            ? html`
                                <span>&gt;</span>
                              `
                            : nothing
                        }
                      `,
                    )
              }
            </span>
            <span class="status__sep">|</span>
            <span>${selectionLabel}</span>
          </div>
        </div>
      </div>
    `;
  }

  protected firstUpdated() {
    this.editorView = new EditorView({
      state: this.createState(this.value),
      parent: this.editorRoot,
    });
    this.syncCursorSummary();
  }

  protected updated(changed: Map<PropertyKey, unknown>) {
    if (!this.editorView) {
      return;
    }

    if (changed.has("disabled")) {
      this.editorView.dispatch({
        effects: [
          this.editableCompartment.reconfigure(EditorView.editable.of(!this.disabled)),
          this.readOnlyCompartment.reconfigure(EditorState.readOnly.of(this.disabled)),
        ],
      });
    }

    if (changed.has("value") && !this.syncingFromEditor) {
      const current = this.editorView.state.doc.toString();
      if (current !== this.value) {
        this.editorView.dispatch({
          changes: { from: 0, to: current.length, insert: this.value },
        });
      }
    }
  }

  disconnectedCallback() {
    this.editorView?.destroy();
    this.editorView = null;
    super.disconnectedCallback();
  }

  setSelection(from: number, to = from) {
    if (!this.editorView) {
      return;
    }
    const docLength = this.editorView.state.doc.length;
    const anchor = Math.max(0, Math.min(from, docLength));
    const head = Math.max(0, Math.min(to, docLength));
    this.editorView.dispatch({
      selection: { anchor, head },
      scrollIntoView: true,
    });
    this.editorView.focus();
  }

  private createState(doc: string): EditorState {
    const extensions: Extension[] = [
      basicSetup,
      keymap.of([indentWithTab]),
      rawEditorTheme,
      this.editableCompartment.of(EditorView.editable.of(!this.disabled)),
      this.readOnlyCompartment.of(EditorState.readOnly.of(this.disabled)),
      EditorView.updateListener.of((update) => {
        if (update.docChanged) {
          const next = update.state.doc.toString();
          if (next !== this.value) {
            this.syncingFromEditor = true;
            this.value = next;
            this.dispatchEvent(
              new CustomEvent("raw-change", {
                detail: { value: next },
                bubbles: true,
                composed: true,
              }),
            );
            this.syncingFromEditor = false;
          }
        }
        if (update.docChanged || update.selectionSet) {
          this.syncCursorSummary(update.state);
        }
      }),
    ];
    return EditorState.create({ doc, extensions });
  }

  private syncCursorSummary(state = this.editorView?.state) {
    if (!state) {
      return;
    }
    const selection = state.selection.main;
    const line = state.doc.lineAt(selection.head);
    this.cursorLine = line.number;
    this.cursorColumn = selection.head - line.from + 1;
    this.cursorBreadcrumbs = resolveJson5BreadcrumbsAt(state.doc.toString(), selection.head);
    this.selectionChars = Math.abs(selection.to - selection.from);
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "config-raw-editor": ConfigRawEditor;
  }
}
