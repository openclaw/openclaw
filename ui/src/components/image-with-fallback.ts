import type { TemplateResult } from "lit";
import { AsyncDirective } from "lit/async-directive.js";
import { directive } from "lit/directive.js";

type ImageRenderer = (url: string | null, onError: () => void) => TemplateResult;

class ImageWithFallbackDirective extends AsyncDirective {
  private source?: string | null;
  private failedSource?: string | null;

  override render(source: string | null | undefined, renderImage: ImageRenderer): TemplateResult {
    if (source !== this.source) {
      this.failedSource = undefined;
      this.source = source;
    }
    const onError = () => {
      // An old image event must not replace a newer source or a removed view.
      if (this.isConnected && this.source === source) {
        this.failedSource = source;
        this.setValue(renderImage(null, onError));
      }
    };
    return renderImage(source && source !== this.failedSource ? source : null, onError);
  }
}

/** Keep an undecodable image on its placeholder until its source changes. */
export const imageWithFallback = directive(ImageWithFallbackDirective);
