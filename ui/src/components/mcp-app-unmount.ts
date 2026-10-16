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
export function createMcpAppUnmountGate<Value = unknown>(
  invalidate: () => void,
  afterCommit?: () => Promise<void>,
) {
  let renderedKey: McpAppUnmountKey | null = null;
  let renderedValue: Value;
  let pending = false;
  let restartTargets: McpAppUnmountTarget[] | null = null;

  function apply(key: McpAppUnmountKey, renderValue: () => Value): Value {
    renderedValue = renderValue();
    renderedKey = key;
    return renderedValue;
  }

  function render(
    key: McpAppUnmountKey,
    renderValue: () => Value,
    leavingRoots: () => Iterable<ParentNode>,
    options: { retainRenderedValue?: boolean; afterCommit?: (effect: () => void) => void } = {},
  ): Value {
    if (pending) {
      return renderedValue;
    }
    const restarting = restartTargets;
    if (restarting) {
      restartTargets = null;
      // Restart only torn-down views that survived the owning renderer's commit.
      const restart = () => {
        for (const target of restarting) {
          if (target.isConnected) {
            target.restartAfterTeardown();
          }
        }
      };
      if (options.afterCommit) {
        options.afterCommit(restart);
      } else if (afterCommit) {
        void afterCommit().then(restart);
      } else {
        queueMicrotask(restart);
      }
    }
    if (renderedKey === key && options.retainRenderedValue) {
      return renderedValue;
    }
    if (restarting || renderedKey === null || renderedKey === key) {
      return apply(key, renderValue);
    }

    const targets = findMcpAppUnmountTargets(leavingRoots());
    if (targets.length === 0) {
      return apply(key, renderValue);
    }

    pending = true;
    void Promise.allSettled(targets.map((target) => target.teardown())).then(() => {
      pending = false;
      restartTargets = targets;
      invalidate();
    });
    return renderedValue;
  }

  return {
    render,
    get retiring() {
      return pending || restartTargets !== null;
    },
  };
}
