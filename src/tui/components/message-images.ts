import {
  type Component,
  Container,
  encodeITerm2,
  getCapabilities,
  getImageDimensions,
  Image,
  renderImage,
  Text,
} from "@earendil-works/pi-tui";
import pLimit from "p-limit";
import { tuiTheme as theme } from "../theme/theme.js";
import type { TuiImageData, TuiImageRequest } from "../tui-backend.js";
import type { TuiImageSource } from "../tui-images.js";

type ImageScope = Pick<TuiImageRequest, "sessionKey" | "agentId">;
export type TuiImageRendererOptions = {
  loadImage: (request: TuiImageRequest) => Promise<TuiImageData>;
  getScope: () => ImageScope;
  requestRender: () => void;
};

const MAX_IMAGE_PREVIEWS = 24;
const MAX_MESSAGE_IMAGE_PREVIEWS = 4;

function createPreviewImage(image: TuiImageData): Component {
  const options = { maxWidthCells: 60, maxHeightCells: 20 };
  const dimensions = getImageDimensions(image.data, image.mimeType);
  if (getCapabilities().images !== "iterm2" || !dimensions) {
    return new Image(image.data, image.mimeType, { fallbackColor: theme.dim }, options);
  }
  let cachedWidth: number | undefined;
  let cachedLines: string[] = [];
  return {
    invalidate() {
      cachedWidth = undefined;
    },
    render(width) {
      if (width === cachedWidth) {
        return cachedLines;
      }
      const rendered = renderImage(image.data, dimensions, {
        ...options,
        maxWidthCells: Math.min(width - 2, options.maxWidthCells),
      });
      if (!rendered) {
        return [];
      }
      const { columns, rows } = rendered;
      // Pi 0.85.1 uses height=auto here. Rounded-up cell widths can make tall
      // portraits exceed the reserved rows; constrain both protocol dimensions.
      const sequence = encodeITerm2(image.data, { width: columns, height: rows });
      cachedLines = [
        ...Array<string>(rows - 1).fill(""),
        `${rows > 1 ? `\x1b[${rows - 1}A` : ""}${sequence}`,
      ];
      cachedWidth = width;
      return cachedLines;
    },
  };
}

/** Owns bounded preview work for the current transcript, independent of model context. */
export class TuiImageRenderer {
  private readonly limit = pLimit(2);
  private readonly previews = new Set<ImagePreview>();

  constructor(private readonly options: TuiImageRendererOptions) {}

  create(source: TuiImageSource): ImagePreview {
    const scope = this.options.getScope();
    const preview = new ImagePreview(
      (signal) =>
        this.limit(() => {
          signal.throwIfAborted();
          return this.options.loadImage({ ...scope, ...source, signal });
        }),
      this.options.requestRender,
      () => this.previews.delete(preview),
    );
    this.previews.add(preview);
    if (this.previews.size > MAX_IMAGE_PREVIEWS) {
      this.previews.values().next().value?.dispose("Image preview limit reached.");
    }
    return preview;
  }

  dispose(): void {
    for (const preview of this.previews) {
      preview.dispose();
    }
  }
}

class ImagePreview extends Container {
  private readonly controller = new AbortController();
  private started = false;

  constructor(
    private readonly load: (signal: AbortSignal) => Promise<TuiImageData>,
    private readonly requestRender: () => void,
    private readonly release: () => void,
  ) {
    super();
  }

  override render(width: number): string[] {
    if (!getCapabilities().images) {
      return [];
    }
    if (!this.started && !this.controller.signal.aborted) {
      this.started = true;
      this.addChild(new Text(theme.dim("Loading image…"), 0, 0));
      void this.load(this.controller.signal).then(
        (image) => {
          if (this.controller.signal.aborted) {
            return;
          }
          this.clear();
          this.addChild(createPreviewImage(image));
          this.requestRender();
        },
        () => {
          if (this.controller.signal.aborted) {
            return;
          }
          this.clear();
          // Source paths, URLs, and transport errors can contain private data.
          this.addChild(new Text(theme.dim("Image preview unavailable."), 0, 0));
          this.requestRender();
        },
      );
    }
    return super.render(width);
  }

  dispose(message?: string): void {
    this.controller.abort();
    this.clear();
    if (message) {
      this.addChild(new Text(theme.dim(message), 0, 0));
    }
    this.release();
  }
}

/** Retains loaded images across text updates and releases them with their message row. */
export class MessageImages extends Container {
  private sources: readonly TuiImageSource[] = [];
  private previews: ImagePreview[] = [];

  constructor(private readonly renderer?: TuiImageRenderer) {
    super();
  }

  setImages(images: readonly TuiImageSource[]): void {
    const renderer = this.renderer;
    if (!renderer || !getCapabilities().images) {
      return;
    }
    const sources = images.slice(0, MAX_MESSAGE_IMAGE_PREVIEWS);
    if (
      sources.length === this.sources.length &&
      sources.every(
        (source, index) =>
          source.source === this.sources[index]?.source &&
          source.artifactId === this.sources[index]?.artifactId,
      )
    ) {
      return;
    }
    this.dispose();
    this.sources = sources;
    this.previews = sources.map((source) => renderer.create(source));
    for (const preview of this.previews) {
      this.addChild(preview);
    }
  }

  dispose(): void {
    for (const preview of this.previews) {
      preview.dispose();
    }
    this.previews = [];
    this.sources = [];
    this.clear();
  }
}
