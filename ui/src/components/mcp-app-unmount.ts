type McpAppUnmountTarget = Element & {
  restartAfterTeardown(): void;
  teardown(): Promise<void>;
};
type McpAppUnmountKey = string | readonly string[];

const registeredTargets = new Set<McpAppUnmountTarget>();

/** Each mounted App owns its registration until its rendering owner disposes. */
export function registerMcpAppUnmountTarget(target: McpAppUnmountTarget): () => void {
  registeredTargets.add(target);
  return () => {
    registeredTargets.delete(target);
  };
}

export function findMcpAppUnmountTargets(roots: Iterable<ParentNode>): McpAppUnmountTarget[] {
  const leavingRoots = [...roots];
  return [...registeredTargets].filter((target) =>
    leavingRoots.some((root) => root.contains(target)),
  );
}

/** Keeps rendered DOM and owner state together until one coalesced MCP teardown completes. */
export function createMcpAppUnmountGate<Value = unknown>(
  invalidate?: () => void,
  afterCommit?: () => Promise<void>,
) {
  let renderedKey: McpAppUnmountKey | null = null;
  let renderedValue: Value;
  let pending = false;
  let restartTargets: McpAppUnmountTarget[] | null = null;
  const listeners = new Set<() => void>();

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
      invalidate?.();
      for (const listener of listeners) {
        listener();
      }
    });
    return renderedValue;
  }

  return {
    render,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    get retiring() {
      return pending || restartTargets !== null;
    },
  };
}
