import type { TemplateResult } from "lit";
import { AsyncDirective } from "lit/async-directive.js";
import { directive } from "lit/directive.js";

export type ImageLoadingState = { loading: boolean; onLoad: () => void };
type ImageRenderer = (
  url: string | null,
  onError: () => void,
  state: ImageLoadingState,
) => TemplateResult;

class ImageWithFallbackDirective extends AsyncDirective {
  private source?: string | null;
  private state: "loading" | "ready" | "failed" = "loading";

  override render(source: string | null | undefined, renderImage: ImageRenderer): TemplateResult {
    if (source !== this.source) {
      this.state = "loading";
      this.source = source;
    }
    const renderCurrent = () => {
      const url = source && this.state !== "failed" ? source : null;
      return renderImage(url, onError, {
        loading: Boolean(url && this.state === "loading"),
        onLoad,
      });
    };
    const onLoad = () => {
      if (this.isConnected && this.source === source && this.state === "loading") {
        this.state = "ready";
        this.setValue(renderCurrent());
      }
    };
    const onError = () => {
      // An old image event must not replace a newer source or a removed view.
      if (this.isConnected && this.source === source) {
        this.state = "failed";
        this.setValue(renderCurrent());
      }
    };
    return renderCurrent();
  }
}

/** Keep an undecodable image on its placeholder until its source changes. */
export const imageWithFallback = directive(ImageWithFallbackDirective);
