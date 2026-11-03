type Registration = {
  callback: () => void;
  subtree: boolean;
  characterData: boolean;
  active: boolean;
};
const documents = new WeakMap<Document, ReturnType<typeof createContentObserver>>();

/** Create a fresh lookup per delivery so DOM moves cannot reuse cached parents. */
export function createMutationTargetLookup(targets: ReadonlyMap<Node, unknown>) {
  const nearest = new Map<Node, Node | null>();
  const trail: Node[] = [];
  return (start: Node | null): Node | null => {
    let node = start;
    trail.length = 0;
    while (node && !targets.has(node)) {
      const cached = nearest.get(node);
      if (cached !== undefined) {
        node = cached;
        break;
      }
      trail.push(node);
      node = node.parentNode;
    }
    for (const skipped of trail) {
      nearest.set(skipped, node);
    }
    return node;
  };
}

function createContentObserver(document: Document) {
  const targets = new Map<Node, Set<Registration>>();
  let rebuildQueued = false;
  const deliver = (records: MutationRecord[]) => {
    const findTarget = createMutationTargetLookup(targets);
    const pending = new Set<Registration>();
    for (const record of records) {
      for (let node = findTarget(record.target); node; node = findTarget(node.parentNode)) {
        for (const registration of targets.get(node) ?? []) {
          if (
            (record.type === "childList" || registration.characterData) &&
            (registration.subtree || record.target === node)
          ) {
            pending.add(registration);
          }
        }
      }
    }
    for (const registration of pending) {
      if (registration.active) {
        try {
          registration.callback();
        } catch (error) {
          // Independent native observers report errors without starving other tooltips.
          reportError(error);
        }
      }
    }
  };
  const observer = new MutationObserver(deliver);
  const observe = (node: Node) => {
    let subtree = false;
    let characterData = false;
    for (const registration of targets.get(node) ?? []) {
      subtree ||= registration.subtree;
      characterData ||= registration.characterData;
    }
    observer.observe(node, { childList: true, characterData, subtree });
  };
  const rebuild = () => {
    if (rebuildQueued) {
      return;
    }
    rebuildQueued = true;
    queueMicrotask(() => {
      rebuildQueued = false;
      // MutationObserver has no unobserve. Drain admitted work, then retire all
      // removed targets in one rebuild for the whole DOM commit.
      deliver(observer.takeRecords());
      observer.disconnect();
      targets.forEach((_registrations, node) => observe(node));
    });
  };
  return {
    register(
      nodes: readonly Node[],
      callback: () => void,
      subtree: boolean,
      characterData: boolean,
    ) {
      const registration = { callback, subtree, characterData, active: true };
      for (const node of nodes) {
        let registrations = targets.get(node);
        if (!registrations) {
          registrations = new Set();
          targets.set(node, registrations);
        }
        registrations.add(registration);
        observe(node);
      }
      return () => {
        if (!registration.active) {
          return;
        }
        registration.active = false;
        let removed = false;
        for (const node of nodes) {
          const registrations = targets.get(node);
          registrations?.delete(registration);
          if (registrations?.size === 0) {
            targets.delete(node);
            removed = true;
          } else if (registrations && (subtree || characterData)) {
            observe(node);
          }
        }
        if (targets.size === 0) {
          observer.disconnect();
          documents.delete(document);
        } else if (removed) {
          rebuild();
        }
      };
    },
  };
}

/** Shared content invalidation; descriptions and reveal policy stay with TooltipOwner. */
export function observeTooltipContent(
  document: Document,
  nodes: readonly Node[],
  callback: () => void,
  { subtree = true, characterData = false }: { subtree?: boolean; characterData?: boolean } = {},
) {
  if (nodes.length === 0) {
    return () => {};
  }
  let observation = documents.get(document);
  if (!observation) {
    observation = createContentObserver(document);
    documents.set(document, observation);
  }
  return observation.register(nodes, callback, subtree, characterData);
}
