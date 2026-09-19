import type { ImageLightboxGallery, ImageLightboxItem } from "./image-lightbox.types.ts";

/** The modal owns decoded neighbors and their resource leases until eviction or close. */
export class ImageLightboxGalleryController {
  index = 0;
  current: ImageLightboxItem | undefined;
  busy = false;
  failed = false;
  private gallery: ImageLightboxGallery | undefined;
  private generation = 0;
  private readonly images = new Map<number, Promise<ImageLightboxItem | null>>();

  constructor(private readonly notify: () => void) {}

  get count() {
    return this.gallery?.items.length ?? 0;
  }

  reset(gallery: ImageLightboxGallery | undefined, initial: ImageLightboxItem) {
    this.dispose();
    this.gallery = gallery;
    this.index = gallery?.index ?? 0;
    this.current = initial;
    // The opener retains and releases the initial image independently of the modal.
    this.images.set(this.index, Promise.resolve({ ...initial, release: undefined }));
    this.preloadNeighbors();
  }

  dispose() {
    this.generation += 1;
    for (const image of this.images.values()) {
      void image.then((item) => item?.release?.());
    }
    this.images.clear();
    this.gallery = undefined;
    this.current = undefined;
    this.busy = false;
    this.failed = false;
  }

  canMove(delta: number) {
    const next = this.index + delta;
    return this.count > 1 && next >= 0 && next < this.count;
  }

  async move(delta: number): Promise<boolean> {
    if (this.busy || !this.canMove(delta)) {
      return false;
    }
    const generation = this.generation;
    const next = this.index + delta;
    this.busy = true;
    this.failed = false;
    this.notify();
    const item = await this.load(next, true);
    if (generation !== this.generation) {
      return false;
    }
    this.busy = false;
    this.failed = !item;
    if (item) {
      this.index = next;
      this.current = item;
      this.preloadNeighbors();
    }
    this.notify();
    return item !== null;
  }

  private load(index: number, retryFailed = false): Promise<ImageLightboxItem | null> {
    const cached = this.images.get(index);
    if (cached) {
      return cached;
    }
    const load = this.gallery?.items[index];
    if (!load) {
      return Promise.resolve(null);
    }
    const generation = this.generation;
    const pending = Promise.resolve()
      .then(() => (generation === this.generation ? load(retryFailed) : null))
      .then(async (item) => {
        if (!item) {
          return null;
        }
        const image = new Image();
        image.referrerPolicy = "no-referrer";
        image.src = item.src;
        try {
          await image.decode();
          return item;
        } catch {
          item.release?.();
          return null;
        }
      })
      .catch(() => null);
    this.images.set(index, pending);
    void pending.then((item) => {
      if (!item && this.images.get(index) === pending) {
        this.images.delete(index);
      }
    });
    return pending;
  }

  private preloadNeighbors() {
    for (const [index, image] of this.images) {
      if (Math.abs(index - this.index) > 1) {
        this.images.delete(index);
        void image.then((item) => item?.release?.());
      }
    }
    for (const index of [this.index - 1, this.index + 1]) {
      if (index >= 0 && index < this.count) {
        void this.load(index);
      }
    }
  }
}
