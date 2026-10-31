import { createMemo, createSignal, Errored, Loading, Show } from "solid-js";
import { registerChatMediaEnglish } from "../i18n/locales/en-chat-media.ts";
import { registerImageComparisonEnglish } from "../i18n/locales/en-image-comparison.ts";
import { formatUiError, UserFacingError } from "../lib/format-error.ts";
import { downloadImageBlob } from "../lib/image-download.ts";
import { registerEnglishCatalog, t } from "../lib/reactive/i18n.ts";
import { compareImagePixels } from "./image-pixel-diff.ts";
import { withPromiseModalHost } from "./promise-modal-host.ts";

registerEnglishCatalog(registerChatMediaEnglish);
registerEnglishCatalog(registerImageComparisonEnglish);

/** Both invocation surfaces use the authorized reader captured by their own lifetime. */
export function showImageComparison(
  readOriginalBlob: () => Promise<Blob>,
  title: string,
  signal: AbortSignal,
): Promise<void> {
  return withPromiseModalHost<void>({ signal, value: undefined }, (modal) =>
    modal.render(() => (
      <ImageComparison
        readOriginalBlob={readOriginalBlob}
        title={title}
        onClose={() => modal.finish()}
      />
    )),
  );
}

async function compareImages(source: Blob, reference: Blob) {
  const left = await createImageBitmap(source);
  try {
    const right = await createImageBitmap(reference);
    try {
      if (left.width !== right.width || left.height !== right.height) {
        throw new UserFacingError(t("chat.imageLightbox.compareDimensions"));
      }
      if (left.width * left.height > 16_000_000) {
        throw new UserFacingError(t("chat.imageLightbox.compareTooLarge"));
      }
      const read = (image: ImageBitmap) => {
        const canvas = document.createElement("canvas");
        canvas.width = image.width;
        canvas.height = image.height;
        const context = canvas.getContext("2d");
        if (!context) {
          throw new UserFacingError(t("chat.imageLightbox.compareFailed"));
        }
        context.drawImage(image, 0, 0);
        return { canvas, pixels: context.getImageData(0, 0, image.width, image.height) };
      };
      const original = read(left);
      const chosen = read(right);
      const diff = compareImagePixels(original.pixels, chosen.pixels);
      if (!diff) {
        throw new UserFacingError(t("chat.imageLightbox.compareDimensions"));
      }
      const output = document.createElement("canvas");
      output.width = left.width;
      output.height = left.height;
      const context = output.getContext("2d");
      if (!context) {
        throw new UserFacingError(t("chat.imageLightbox.compareFailed"));
      }
      context.putImageData(new ImageData(diff.data, left.width, left.height), 0, 0);
      return {
        changedPixels: diff.changedPixels,
        totalPixels: diff.totalPixels,
        original: original.canvas.toDataURL("image/png"),
        reference: chosen.canvas.toDataURL("image/png"),
        difference: output.toDataURL("image/png"),
      };
    } finally {
      right.close();
    }
  } finally {
    left.close();
  }
}

export function ImageComparison(props: {
  readOriginalBlob: () => Promise<Blob>;
  title: string;
  onClose: () => void;
}) {
  const [attempt, setAttempt] = createSignal<{ result: ReturnType<typeof compareImages> }>();
  const result = createMemo(() => attempt()?.result ?? null);
  let input!: HTMLInputElement;
  const imageStyle = {
    display: "block",
    width: "100%",
    height: "auto",
    background: "var(--bg-elevated)",
    border: "1px solid var(--border)",
  } as const;
  const captionStyle = { "margin-bottom": "0.5rem", color: "var(--muted)" } as const;
  const choose = (event: Event) => {
    const target = event.currentTarget;
    if (!(target instanceof HTMLInputElement)) {
      return;
    }
    const file = target.files?.[0];
    target.value = "";
    if (!file) {
      return;
    }
    // Reading the authorized source is an admitted user action, never a rendering side effect.
    const completion = Promise.resolve().then(async () =>
      compareImages(await props.readOriginalBlob(), file),
    );
    void completion.catch(() => {});
    setAttempt({ result: completion });
  };
  return (
    <openclaw-modal-dialog
      label={t("chat.imageLightbox.compareTitle", { title: props.title })}
      style={{ "--openclaw-modal-width": "64rem" }}
      onModal-cancel={() => props.onClose()}
    >
      <div
        class="image-comparison"
        style={{
          display: "grid",
          gap: "0.75rem",
          padding: "1rem",
          "max-height": "var(--openclaw-modal-height-limit)",
          overflow: "auto",
          "border-radius": "var(--radius-xl)",
          background: "var(--bg)",
        }}
      >
        <p style={{ margin: 0 }}>{t("chat.imageLightbox.compareHint")}</p>
        <input
          ref={(element) => {
            input = element;
          }}
          type="file"
          accept="image/*"
          class="sr-only"
          tabindex="-1"
          aria-hidden="true"
          onChange={choose}
        />
        <Loading on={attempt()} fallback={<p role="status">{t("common.loading")}</p>}>
          <Errored
            fallback={(error) => (
              <p role="alert">{formatUiError(error(), t("chat.imageLightbox.compareFailed"))}</p>
            )}
          >
            <Show when={result()}>
              {(comparison) => (
                <>
                  <p role="status" class="image-comparison__count" style={{ margin: 0 }}>
                    {t("chat.imageLightbox.compareCount", {
                      count: String(comparison().changedPixels),
                      total: String(comparison().totalPixels),
                      percent: (
                        (100 * comparison().changedPixels) /
                        comparison().totalPixels
                      ).toFixed(2),
                    })}
                  </p>
                  <div
                    style={{
                      display: "grid",
                      "grid-template-columns": "repeat(auto-fit, minmax(min(100%, 12rem), 1fr))",
                      gap: "0.75rem",
                    }}
                  >
                    <figure style={{ margin: 0 }}>
                      <figcaption style={captionStyle}>
                        {t("chat.imageLightbox.compareOriginal")}
                      </figcaption>
                      <img
                        style={imageStyle}
                        src={comparison().original}
                        alt={t("chat.imageLightbox.compareOriginal")}
                      />
                    </figure>
                    <figure style={{ margin: 0 }}>
                      <figcaption style={captionStyle}>
                        {t("chat.imageLightbox.compareReference")}
                      </figcaption>
                      <img
                        style={imageStyle}
                        src={comparison().reference}
                        alt={t("chat.imageLightbox.compareReference")}
                      />
                    </figure>
                    <figure style={{ margin: 0 }}>
                      <figcaption style={captionStyle}>
                        {t("chat.imageLightbox.compareDifference")}
                      </figcaption>
                      <img
                        style={imageStyle}
                        src={comparison().difference}
                        alt={t("chat.imageLightbox.compareDifference")}
                      />
                    </figure>
                  </div>
                  <button
                    class="btn"
                    type="button"
                    onClick={() => {
                      const data = comparison().difference.split(",")[1] ?? "";
                      downloadImageBlob(
                        new Blob([Uint8Array.from(atob(data), (value) => value.charCodeAt(0))], {
                          type: "image/png",
                        }),
                        "difference.png",
                      );
                    }}
                  >
                    {t("chat.imageLightbox.compareDownload")}
                  </button>
                </>
              )}
            </Show>
          </Errored>
        </Loading>
        <openclaw-modal-actions>
          <button class="btn" type="button" onClick={() => props.onClose()}>
            {t("common.close")}
          </button>
          <button class="btn primary" type="button" onClick={() => input.click()}>
            {t("chat.imageLightbox.compareChoose")}
          </button>
        </openclaw-modal-actions>
      </div>
    </openclaw-modal-dialog>
  );
}
