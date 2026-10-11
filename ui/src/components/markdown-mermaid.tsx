import {
  MermaidTransientError,
  renderMermaidSvg,
  type MermaidTheme,
} from "@openclaw/mermaid-renderer";
import { createEffect, createMemo, createSignal, onCleanup, Show } from "solid-js";
import { pruneMapToMaxSize } from "../../../src/infra/map-size.ts";
import { copyToClipboard } from "../lib/clipboard.ts";
import { t } from "../lib/reactive/i18n.ts";
import { resolveThemeColor } from "../lib/theme-color.ts";
import { defineSolidBridge, type SolidBridgeElement } from "../lit/solid-bridge.ts";
import { Icon } from "./solid/icon.tsx";
import mermaidStyles from "./markdown-mermaid.css?inline";
import "./image-lightbox.tsx";
import "./web-awesome.ts";

declare module "@solidjs/web" {
  namespace JSX {
    interface IntrinsicElements {
      "openclaw-image-lightbox": HTMLAttributes<HTMLElementTagNameMap["openclaw-image-lightbox"]> &
        Properties<HTMLElementTagNameMap["openclaw-image-lightbox"]> & {
          "onImage-lightbox-close"?: () => void;
        };
    }
  }
}

const CACHE_LIMIT = 16;
const diagrams = new Map<string, Promise<string>>();

function currentTheme(): MermaidTheme {
  const root = document.documentElement;
  const styles = getComputedStyle(root);
  const darkMode = root.dataset.themeMode === "dark";
  return {
    background: resolveThemeColor(styles, "--card") || (darkMode ? "#181818" : "#ffffff"),
    foreground: resolveThemeColor(styles, "--text") || (darkMode ? "#eeeeee" : "#171717"),
    muted: resolveThemeColor(styles, "--muted") || "#888888",
    border: resolveThemeColor(styles, "--border-hover") || "#888888",
    accent: resolveThemeColor(styles, "--accent") || "#888888",
    fontFamily: styles.getPropertyValue("--font-body").trim() || "system-ui, sans-serif",
    darkMode,
  };
}

function cachedDiagram(key: string, source: string, theme: MermaidTheme): Promise<string> {
  let result = diagrams.get(key);
  if (result) {
    diagrams.delete(key);
  } else {
    result = renderMermaidSvg(source, theme);
    void result.catch(() => {
      if (diagrams.get(key) === result) {
        diagrams.delete(key);
      }
    });
  }
  diagrams.set(key, result);
  pruneMapToMaxSize(diagrams, CACHE_LIMIT);
  return result;
}

type MermaidProps = { source: string };
type MermaidElement = SolidBridgeElement<MermaidProps>;
type RenderStatus = "rendering" | "error" | "rendererError" | "imageError";

function MermaidContent(props: MermaidProps, host: MermaidElement) {
  const [imageUrl, setImageUrl] = createSignal("");
  const [showSource, setShowSource] = createSignal(false);
  const [expanded, setExpanded] = createSignal(false);
  const [renderStatus, setRenderStatus] = createSignal<RenderStatus>();
  const [copyResult, setCopyResult] = createSignal<boolean>();
  const [themeRevision, setThemeRevision] = createSignal(0);
  let allocatedUrl = "";
  let renderedSource: string | undefined;
  let copyAttempt = 0;
  let disposed = false;
  const themeObserver = new MutationObserver(() => setThemeRevision((value) => value + 1));
  themeObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme", "data-theme-mode", "style"],
  });

  function releaseImage() {
    if (allocatedUrl) {
      URL.revokeObjectURL(allocatedUrl);
      allocatedUrl = "";
      setImageUrl("");
    }
  }

  const request = createMemo(
    () => {
      themeRevision();
      const source = props.source;
      const theme = currentTheme();
      return { source, theme, key: JSON.stringify([source, theme]) };
    },
    { equals: (previous, next) => previous.key === next.key },
  );

  createEffect(
    () => request(),
    ({ source, theme, key }) => {
      let current = true;
      if (source !== renderedSource) {
        renderedSource = source;
        copyAttempt += 1;
        setCopyResult(undefined);
        releaseImage();
      }
      setRenderStatus("rendering");
      void cachedDiagram(key, source, theme).then(
        (svg) => {
          // Edits, theme switches and disconnects can overtake asynchronous layout.
          if (!current || disposed || !host.isConnected) {
            return;
          }
          releaseImage();
          allocatedUrl = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
          setImageUrl(allocatedUrl);
          setRenderStatus(undefined);
        },
        (error: unknown) => {
          if (current && !disposed && host.isConnected) {
            releaseImage();
            setRenderStatus(error instanceof MermaidTransientError ? "rendererError" : "error");
          }
        },
      );
      return () => {
        current = false;
      };
    },
  );

  onCleanup(() => {
    disposed = true;
    themeObserver.disconnect();
    copyAttempt += 1;
    releaseImage();
  });

  async function copySource() {
    const attempt = ++copyAttempt;
    const source = props.source;
    const isCurrent = () =>
      !disposed && host.isConnected && attempt === copyAttempt && host.source === source;
    const copied = await copyToClipboard(source, isCurrent);
    if (isCurrent()) {
      setCopyResult(copied);
    }
  }

  const failed = () => renderStatus() !== undefined && renderStatus() !== "rendering";
  const sourceVisible = () => showSource() || failed();
  const copyLabel = () =>
    t(
      copyResult() === undefined
        ? "chat.mermaid.copySource"
        : copyResult()
          ? "common.copied"
          : "common.copyFailed",
    );
  return (
    <>
      <style>{mermaidStyles}</style>
      <div class="actions">
        <button
          class="copy-button"
          type="button"
          aria-label={copyLabel()}
          title={copyLabel()}
          onClick={() => void copySource()}
        >
          <span aria-hidden="true">
            <Icon name={copyResult() === undefined ? "copy" : copyResult() ? "check" : "x"} />
          </span>
        </button>
        <wa-dropdown
          placement="bottom-end"
          prop:size="s"
          prop:distance={4}
          aria-label={t("chat.mermaid.options")}
          onWa-select={(event) => {
            const action = event.detail.item.value;
            if (action === "expand") setExpanded(true);
            else if (action === "source" || action === "diagram")
              setShowSource(action === "source");
          }}
        >
          <button
            slot="trigger"
            type="button"
            aria-label={t("chat.mermaid.options")}
            title={t("chat.mermaid.options")}
          >
            <span aria-hidden="true">
              <Icon name="moreHorizontal" />
            </span>
          </button>
          <wa-dropdown-item
            value={sourceVisible() ? "diagram" : "source"}
            disabled={sourceVisible() && !imageUrl()}
          >
            {t(sourceVisible() ? "chat.mermaid.diagram" : "chat.mermaid.source")}
          </wa-dropdown-item>
          <wa-dropdown-item value="expand" disabled={!imageUrl()}>
            {t("chat.mermaid.expand")}
          </wa-dropdown-item>
        </wa-dropdown>
      </div>
      <span class="copy-feedback" aria-live="polite">
        {copyResult() === undefined ? undefined : copyLabel()}
      </span>
      <Show when={renderStatus() && (failed() || !imageUrl())}>
        <p class="status" role="status">
          {t(`chat.mermaid.${renderStatus()}`)}
        </p>
      </Show>
      <Show
        when={sourceVisible()}
        fallback={
          <Show when={imageUrl()}>
            <div class="preview">
              <img
                src={imageUrl()}
                alt={t("chat.mermaid.title")}
                onError={() => {
                  setRenderStatus("imageError");
                  releaseImage();
                }}
              />
            </div>
          </Show>
        }
      >
        <pre class="source">
          <code>{props.source}</code>
        </pre>
      </Show>
      <Show when={expanded() && imageUrl()}>
        <openclaw-image-lightbox
          prop:src={imageUrl()}
          prop:imageTitle={t("chat.mermaid.title")}
          onImage-lightbox-close={() => setExpanded(false)}
        />
      </Show>
    </>
  );
}

export const Mermaid = defineSolidBridge<MermaidProps>("openclaw-mermaid", MermaidContent, {
  properties: { source: { default: "", attribute: false } },
});

export function mountMermaidBlocks(root: Element): boolean {
  let mounted = false;
  const blocks = root.matches(".markdown-mermaid")
    ? [root]
    : root.querySelectorAll(".markdown-mermaid");
  for (const block of blocks) {
    // The mounted light-DOM component can itself show source or an error.
    if (block.querySelector("openclaw-mermaid")) {
      continue;
    }
    const code = block.querySelector("pre code");
    if (!code) {
      continue;
    }
    const diagram = document.createElement("openclaw-mermaid");
    diagram.source = code.textContent ?? "";
    block.replaceChildren(diagram);
    mounted = true;
  }
  return mounted;
}

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-mermaid": MermaidElement;
  }
}
