import type { ControlUiLinkReaderImage } from "../../../src/shared/control-ui-link-reader.js";
import type { GatewayBrowserClient } from "../api/gateway.ts";

const MAX_IMAGES = 32;
const MAX_CONCURRENT = 4;
const MAX_DATA_URL_LENGTH = Math.ceil((2 * 1024 * 1024) / 3) * 4 + 64;
const MAX_DOCUMENT_DATA = 8 * 1024 * 1024;

/** Image requests and their bounded cache belong to one loaded document. */
export class LinkReaderImages {
  private readonly abort = new AbortController();
  private readonly cache = new Map<string, Promise<string>>();
  private readonly queue: Array<() => void> = [];
  private active = 0;
  private bytes = 0;

  constructor(
    private readonly client: GatewayBrowserClient,
    private readonly method: string,
    private readonly isCurrent: () => boolean,
  ) {}

  readonly load = (url: string): Promise<string> => {
    const existing = this.cache.get(url);
    if (existing) {
      return existing;
    }
    if (this.abort.signal.aborted || !this.isCurrent()) {
      return Promise.reject(new Error("Reader image is unavailable"));
    }
    if (this.cache.size >= MAX_IMAGES) {
      return Promise.resolve(url);
    }
    const result = new Promise<string>((resolve, reject) => {
      this.queue.push(() => {
        void this.request(url)
          .then(resolve, () => {
            // Preserve anonymous-CORS images that the plugin resolver cannot serve.
            if (!this.abort.signal.aborted && this.isCurrent()) {
              resolve(url);
            } else {
              reject(new Error("Reader image is unavailable"));
            }
          })
          .finally(() => {
            this.active--;
            this.drain();
          });
      });
    });
    this.cache.set(url, result);
    this.drain();
    return result;
  };

  dispose(): void {
    this.abort.abort();
    this.cache.clear();
    this.drain();
  }

  private drain(): void {
    while (this.active < MAX_CONCURRENT && this.queue.length) {
      this.active++;
      this.queue.shift()!();
    }
  }

  private async request(url: string): Promise<string> {
    if (this.abort.signal.aborted || !this.isCurrent()) {
      throw new Error("Reader image is unavailable");
    }
    const result = await this.client.request<ControlUiLinkReaderImage>(
      this.method,
      { url },
      { signal: this.abort.signal },
    );
    if (
      this.abort.signal.aborted ||
      !this.isCurrent() ||
      result?.url !== url ||
      typeof result.dataUrl !== "string" ||
      result.dataUrl.length > MAX_DATA_URL_LENGTH ||
      this.bytes + result.dataUrl.length > MAX_DOCUMENT_DATA ||
      !/^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+={0,2}$/u.test(result.dataUrl)
    ) {
      throw new Error("Reader image is unavailable");
    }
    this.bytes += result.dataUrl.length;
    return result.dataUrl;
  }
}
