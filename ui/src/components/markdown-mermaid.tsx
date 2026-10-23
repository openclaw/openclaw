import {
  MermaidTransientError,
  renderMermaidSvg,
  type MermaidTheme,
} from "@openclaw/mermaid-renderer";
import type { JSX as SolidJSX } from "@solidjs/web";
import {
  createEffect,
  createMemo,
  createSignal,
  createUniqueId,
  Errored,
  Loading,
  onCleanup,
  onSettled,
  Show,
} from "solid-js";
import { pruneMapToMaxSize } from "../../../src/infra/map-size.ts";
import { copyToClipboard } from "../lib/clipboard.ts";
import { t } from "../lib/reactive/i18n.ts";
import { defineSolidBridge, type SolidBridgeElement } from "../lib/solid-bridge.ts";
import { resolveThemeColor } from "../lib/theme-color.ts";
import { Icon } from "./solid/icon.tsx";
import { Menu } from "./solid/menu.tsx";
import mermaidStyles from "./markdown-mermaid.css?inline";
import "./image-lightbox.tsx";

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
const imageFailure = new Error("Mermaid image could not be displayed");

function MermaidContent(props: MermaidProps, host: MermaidElement) {
  const menuId = createUniqueId();
  const descriptionId = createUniqueId();
  const [showSource, setShowSource] = createSignal(false);
  const [expanded, setExpanded] = createSignal(false);
  const source = createMemo(() => props.source);
  const [copyResult, setCopyResult] = createSignal<boolean | undefined>(() => {
    source();
    return undefined;
  });
  const [themeRevision, setThemeRevision] = createSignal(0);
  let copyAttempt = 0;
  let disposed = false;
  const image = createMemo(() => {
    source();
    const [value, setValue] = createSignal<{ url: string; title: string; description: string }>();
    let allocatedUrl = "";
    let key = "";
    function revoke() {
      if (allocatedUrl) {
        URL.revokeObjectURL(allocatedUrl);
      }
      allocatedUrl = "";
    }
    function release() {
      revoke();
      setValue(undefined);
    }
    // Source replacement retires its URL even while the next layout is pending.
    onCleanup(revoke);
    return {
      value,
      release,
      accept(result: { svg: string; key: string }) {
        revoke();
        key = result.key;
        allocatedUrl = URL.createObjectURL(new Blob([result.svg], { type: "image/svg+xml" }));
        // Mermaid owns accTitle/accDescr parsing. Read only its sanitized SVG's
        // root metadata as text; never mount the SVG or interpret source as HTML.
        const root = new DOMParser().parseFromString(result.svg, "image/svg+xml").documentElement;
        const metadata = (name: string) =>
          [...root.children].find((child) => child.localName === name)?.textContent?.trim() ?? "";
        setValue({ url: allocatedUrl, title: metadata("title"), description: metadata("desc") });
      },
      fail() {
        setFailedImageKey(key);
        release();
      },
    };
  });
  const imageUrl = () => image().value()?.url ?? "";
  const imageTitle = () => image().value()?.title || t("chat.mermaid.title");
  const imageDescription = () => image().value()?.description ?? "";

  const request = createMemo(
    () => {
      themeRevision();
      const value = source();
      const theme = currentTheme();
      return { source: value, theme, key: JSON.stringify([value, theme]) };
    },
    { equals: (previous, next) => previous.key === next.key },
  );
  const [failedImageKey, setFailedImageKey] = createSignal(() => {
    request();
    return "";
  });

  const layout = createMemo(() => {
    const { source: value, theme, key } = request();
    return cachedDiagram(key, value, theme).then((svg) => ({ svg, key }));
  });
  const diagram = createMemo(() => {
    const result = layout();
    if (failedImageKey() === result.key) {
      throw imageFailure;
    }
    return result;
  });

  onSettled(() => {
    const themeObserver = new MutationObserver(() => setThemeRevision((value) => value + 1));
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme", "data-theme-mode", "style"],
    });
    return () => {
      disposed = true;
      themeObserver.disconnect();
      copyAttempt += 1;
    };
  });

  async function copySource() {
    const attempt = ++copyAttempt;
    const copiedSource = props.source;
    const resource = image();
    const isCurrent = () =>
      !disposed &&
      host.isConnected &&
      attempt === copyAttempt &&
      host.source === copiedSource &&
      image() === resource;
    const copied = await copyToClipboard(copiedSource, isCurrent);
    if (isCurrent()) {
      setCopyResult(copied);
    }
  }

  const copyLabel = () =>
    t(
      copyResult() === undefined
        ? "chat.mermaid.copySource"
        : copyResult()
          ? "common.copied"
          : "common.copyFailed",
    );
  function Content(viewProps: { status?: RenderStatus }) {
    const failed = () => viewProps.status !== undefined && viewProps.status !== "rendering";
    const sourceVisible = () => showSource() || failed();
    return (
      <>
        <Show when={viewProps.status && (failed() || !imageUrl())}>
          <p class="status" role="status">
            {t(`chat.mermaid.${viewProps.status}`)}
          </p>
        </Show>
        <Show
          when={sourceVisible()}
          fallback={
            <Show when={imageUrl()}>
              <button
                class="preview"
                type="button"
                aria-label={
                  image().value()?.title
                    ? t("chat.mermaid.expandNamed", { title: imageTitle() })
                    : t("chat.mermaid.expand")
                }
                aria-describedby={imageDescription() ? descriptionId : undefined}
                aria-haspopup="dialog"
                title={t("chat.mermaid.expand")}
                onClick={() => setExpanded(true)}
              >
                <img
                  src={imageUrl()}
                  alt={imageTitle()}
                  aria-describedby={imageDescription() ? descriptionId : undefined}
                  onError={() => image().fail()}
                />
                <Show when={imageDescription()}>
                  <span class="description" id={descriptionId} hidden>
                    {imageDescription()}
                  </span>
                </Show>
              </button>
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
            prop:imageTitle={imageTitle()}
            prop:imageDescription={imageDescription()}
            onImage-lightbox-close={() => setExpanded(false)}
          />
        </Show>
      </>
    );
  }

  function Ready(readyProps: { result: { svg: string; key: string } }) {
    createEffect(
      () => ({ result: readyProps.result, resource: image() }),
      ({ result, resource }) => {
        if (disposed || !host.isConnected) {
          return undefined;
        }
        resource.accept(result);
        return () => resource.release();
      },
    );
    return <Content />;
  }

  function Failed(failureProps: { error: unknown }) {
    onSettled(() => image().release());
    return (
      <View
        status={
          failureProps.error === imageFailure
            ? "imageError"
            : failureProps.error instanceof MermaidTransientError
              ? "rendererError"
              : "error"
        }
      />
    );
  }

  function View(viewProps: { status?: RenderStatus; children?: SolidJSX.Element }) {
    const sourceVisible = () => showSource() || viewProps.status !== undefined;
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
          <Menu
            id={menuId}
            label={t("chat.mermaid.options")}
            placement="bottom-end"
            triggerAttributes={{ title: t("chat.mermaid.options") }}
            trigger={
              <span aria-hidden="true">
                <Icon name="moreHorizontal" />
              </span>
            }
            items={[
              {
                id: sourceVisible() ? "diagram" : "source",
                label: t(sourceVisible() ? "chat.mermaid.diagram" : "chat.mermaid.source"),
                disabled: sourceVisible() && !imageUrl(),
              },
              { id: "expand", label: t("chat.mermaid.expand"), disabled: !imageUrl() },
            ]}
            onSelect={(item) => {
              if (item.id === "expand") {
                setExpanded(true);
              } else if (item.id === "source" || item.id === "diagram") {
                setShowSource(item.id === "source");
              }
            }}
          />
        </div>
        <span class="copy-feedback" aria-live="polite">
          {copyResult() === undefined ? undefined : copyLabel()}
        </span>
        {viewProps.children ?? <Content status={viewProps.status} />}
      </>
    );
  }

  return (
    <Errored fallback={(error) => <Failed error={error()} />}>
      <View>
        <Loading on={source()} fallback={<Content status="rendering" />}>
          <Show when={diagram()}>{(result) => <Ready result={result()} />}</Show>
        </Loading>
      </View>
    </Errored>
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
