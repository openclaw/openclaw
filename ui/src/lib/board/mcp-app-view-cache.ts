import type { BoardWidget, BoardWidgetAppViewResult } from "@openclaw/gateway-protocol";
import { getOrCreatePromise } from "../../../../src/shared/lazy-promise.ts";
import type { BoardWidgetAppViewState } from "./view-types.ts";

export class BoardMcpAppViewCache {
  private readonly entries = new Map<string, Promise<BoardWidgetAppViewState>>();

  clear(): void {
    this.entries.clear();
  }

  prune(widgets: readonly BoardWidget[]): void {
    const validKeys = new Set(
      widgets
        .filter((widget) => widget.contentKind === "mcp-app")
        .map((widget) => this.key(widget)),
    );
    for (const key of this.entries.keys()) {
      if (!validKeys.has(key)) {
        this.entries.delete(key);
      }
    }
  }

  async resolve(
    widget: BoardWidget,
    request: () => Promise<BoardWidgetAppViewResult>,
    force: boolean,
  ): Promise<BoardWidgetAppViewState> {
    const key = this.key(widget);
    if (force) {
      this.entries.delete(key);
    }
    return await getOrCreatePromise(this.entries, key, () =>
      request()
        .then<BoardWidgetAppViewState>((result) => ({ status: "ready", ...result }))
        .catch<BoardWidgetAppViewState>(() => ({
          status: "stale",
        })),
    );
  }

  private key(widget: BoardWidget): string {
    return `${widget.name}\0${widget.revision}\0${widget.instanceId ?? ""}\0${widget.grantState}`;
  }
}
