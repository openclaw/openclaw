import type { ReactiveControllerHost } from "lit";

export class LazyRenderer<Renderer> {
  renderer: Renderer | null = null;
  failed = false;
  private pending: Promise<void> | null = null;

  constructor(
    private readonly host: Pick<ReactiveControllerHost, "requestUpdate">,
    private readonly importRenderer: () => Promise<Renderer>,
  ) {}

  load(): void {
    this.pending ??= this.importRenderer()
      .then((renderer) => {
        this.renderer = renderer;
        this.failed = false;
        this.host.requestUpdate();
      })
      .catch(() => {
        this.failed = true;
        this.pending = null;
        this.host.requestUpdate();
      });
  }

  retry(): void {
    if (this.failed) {
      this.failed = false;
      this.host.requestUpdate();
    }
    this.load();
  }
}
