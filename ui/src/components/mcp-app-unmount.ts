import type { ReactiveControllerHost } from "lit";

type McpAppUnmountTarget = Element & {
  restartAfterTeardown(): void;
  teardown(): Promise<void>;
};
type McpAppUnmountKey = string | readonly string[];

function isMcpAppUnmountTarget(value: Element): value is McpAppUnmountTarget {
  return (
    typeof Reflect.get(value, "restartAfterTeardown") === "function" &&
    typeof Reflect.get(value, "teardown") === "function"
  );
}

function findMcpAppUnmountTargets(roots: Iterable<ParentNode>): McpAppUnmountTarget[] {
  const targets = new Set<McpAppUnmountTarget>();
  for (const root of roots) {
    if (root instanceof Element && root.matches("mcp-app-view") && isMcpAppUnmountTarget(root)) {
      targets.add(root);
    }
    for (const candidate of root.querySelectorAll("mcp-app-view")) {
      if (isMcpAppUnmountTarget(candidate)) {
        targets.add(candidate);
      }
    }
  }
  return [...targets];
}

/** Keeps rendered DOM and owner state together until one coalesced MCP teardown completes. */
export class McpAppUnmountGate {
  private renderedKey: McpAppUnmountKey | null = null;
  private renderedValue: unknown;
  private pending = false;
  private restartTargets: McpAppUnmountTarget[] | null = null;

  constructor(private readonly host: ReactiveControllerHost) {}

  get retiring(): boolean {
    return this.pending || this.restartTargets !== null;
  }

  private apply(key: McpAppUnmountKey, renderValue: () => unknown): unknown {
    this.renderedValue = renderValue();
    this.renderedKey = key;
    return this.renderedValue;
  }

  render(
    key: McpAppUnmountKey,
    renderValue: () => unknown,
    leavingRoots: () => Iterable<ParentNode>,
    options: { retainRenderedValue?: boolean } = {},
  ): unknown {
    if (this.pending) {
      return this.renderedValue;
    }
    if (this.restartTargets) {
      const targets = this.restartTargets;
      this.restartTargets = null;
      // Lit commits the parent update synchronously after render. Restart only
      // torn-down views that survived that commit; retained siblings stay intact.
      queueMicrotask(() => {
        for (const target of targets) {
          if (target.isConnected) {
            target.restartAfterTeardown();
          }
        }
      });
      return this.renderedKey === key && options.retainRenderedValue
        ? this.renderedValue
        : this.apply(key, renderValue);
    }
    if (this.renderedKey === key && options.retainRenderedValue) {
      return this.renderedValue;
    }
    if (this.renderedKey === null || this.renderedKey === key) {
      return this.apply(key, renderValue);
    }

    const targets = findMcpAppUnmountTargets(leavingRoots());
    if (targets.length === 0) {
      return this.apply(key, renderValue);
    }

    this.pending = true;
    void Promise.allSettled(targets.map((target) => target.teardown())).then(() => {
      this.pending = false;
      this.restartTargets = targets;
      this.host.requestUpdate();
    });
    return this.renderedValue;
  }
}
