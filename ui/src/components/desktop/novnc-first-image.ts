/* eslint-disable no-underscore-dangle -- Exact noVNC 1.7.0 private instance names are the explicitly pinned adapter contract. */

/** Private, instance-local adapter for the exact @novnc/novnc 1.7.0 UI pin.
 * Recheck core/rfb.js and core/display.js when upgrading that dependency.
 */
type Rectangle = { x: number; y: number; width: number; height: number };
type Display = {
  width: number;
  height: number;
  _damageBounds: { left: number; top: number; right: number; bottom: number };
  _viewportLoc: { x: number; y: number; w: number; h: number };
  _damage(x: number, y: number, width: number, height: number): void;
  _scanRenderQ(): void;
  flip(fromQueue?: boolean): void;
  resize(width: number, height: number): void;
  pending(): boolean;
};

export type NoVncFirstImageHost = {
  _display: Display;
  _handleDataRect(): boolean;
};

function intersection(left: Rectangle, right: Rectangle): Rectangle | undefined {
  const x = Math.max(left.x, right.x);
  const y = Math.max(left.y, right.y);
  const width = Math.min(left.x + left.width, right.x + right.width) - x;
  const height = Math.min(left.y + left.height, right.y + right.height) - y;
  return width > 0 && height > 0 ? { x, y, width, height } : undefined;
}

/** Observes the first primary framebuffer paint, not ServerInit or cursor/resize damage. */
export function observeNoVncFirstImage(
  rfb: NoVncFirstImageHost,
  isCurrent: () => boolean,
  onFirstImage: () => void,
): () => void {
  const display = rfb._display;
  const original = {
    data: rfb._handleDataRect.bind(rfb),
    scan: display._scanRenderQ.bind(display),
    damage: display._damage.bind(display),
    resize: display.resize.bind(display),
    flip: display.flip.bind(display),
  };
  let active = true;
  let drawingPixels = 0;
  // Only until the first visible paint. Keeping rectangles (rather than their
  // bounding box) avoids treating a resize into an unwritten gap as an image.
  let imageDamage: Rectangle[] = [];
  const restorations: Array<() => void> = [];
  const dispose = () => {
    if (!active) {
      return;
    }
    active = false;
    imageDamage = [];
    restorations.toReversed().forEach((restore) => restore());
  };
  function replace<Owner extends object, Key extends keyof Owner>(
    owner: Owner,
    key: Key,
    replacement: Owner[Key],
  ): void {
    const descriptor = Object.getOwnPropertyDescriptor(owner, key);
    owner[key] = replacement;
    restorations.push(() => {
      if (owner[key] !== replacement) {
        return;
      }
      if (descriptor) {
        Object.defineProperty(owner, key, descriptor);
      } else {
        Reflect.deleteProperty(owner, key);
      }
    });
  }
  try {
    replace(rfb, "_handleDataRect", () => {
      drawingPixels += 1;
      try {
        return original.data();
      } finally {
        drawingPixels -= 1;
      }
    });
    // Async PNG/JPEG/video and deferred blits/fills/copies execute here.
    // The original scan/flush/resume owner and its ordering stay unchanged.
    replace(display, "_scanRenderQ", () => {
      drawingPixels += 1;
      try {
        original.scan();
      } finally {
        drawingPixels -= 1;
      }
    });
    replace(display, "_damage", (x, y, width, height) => {
      original.damage(x, y, width, height);
      if (active && drawingPixels > 0) {
        const pixels = intersection(
          { x, y, width, height },
          { x: 0, y: 0, width: display.width, height: display.height },
        );
        if (pixels) {
          imageDamage.push(pixels);
        }
      }
    });
    replace(display, "resize", (width, height) => {
      // Display.resize preserves only the old backbuffer's overlapping pixels.
      imageDamage = imageDamage.flatMap(
        (rectangle) => intersection(rectangle, { x: 0, y: 0, width, height }) ?? [],
      );
      original.resize(width, height);
    });
    replace(display, "flip", (fromQueue) => {
      const bounds = display._damageBounds;
      const viewport = display._viewportLoc;
      const visible = intersection(
        {
          x: bounds.left,
          y: bounds.top,
          width: bounds.right - bounds.left,
          height: bounds.bottom - bounds.top,
        },
        { x: viewport.x, y: viewport.y, width: viewport.w, height: viewport.h },
      );
      // 1.7.0 queues flip() while decoding is pending; flip(true) is the
      // queue-owned call that actually copies damaged backbuffer pixels to canvas.
      const paintsImage =
        (fromQueue === true || !display.pending()) &&
        visible &&
        imageDamage.some((pixels) => intersection(pixels, visible));
      original.flip(fromQueue);
      if (active) {
        const current = isCurrent();
        if (!current || paintsImage) {
          dispose();
          if (current && paintsImage) {
            onFirstImage();
          }
        }
      }
    });
  } catch (error) {
    dispose();
    throw error;
  }
  return dispose;
}
