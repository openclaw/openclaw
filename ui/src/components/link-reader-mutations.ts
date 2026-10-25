type Registration = { notify: () => void; active: boolean };
const documents = new WeakMap<Document, ReturnType<typeof createInlineObserver>>();

function createInlineObserver(document: Document) {
  const targets = new Map<Node, Set<Registration>>();
  let rebuildQueued = false;
  const deliver = (records: MutationRecord[]) => {
    const pending = new Set<Registration>();
    for (const record of records) {
      for (let node: Node | null = record.target; node; node = node.parentNode) {
        for (const registration of targets.get(node) ?? []) {
          pending.add(registration);
        }
      }
    }
    for (const registration of pending) {
      if (registration.active) {
        try {
          registration.notify();
        } catch (error) {
          reportError(error);
        }
      }
    }
  };
  const observer = new MutationObserver(deliver);
  const observe = (host: Node) =>
    observer.observe(host, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["href"],
    });
  return {
    register(host: HTMLElement, notify: () => void) {
      const registration = { notify, active: true };
      let registrations = targets.get(host);
      if (!registrations) {
        registrations = new Set();
        targets.set(host, registrations);
        observe(host);
      }
      registrations.add(registration);
      return () => {
        if (!registration.active) {
          return;
        }
        registration.active = false;
        registrations.delete(registration);
        if (registrations.size > 0) {
          return;
        }
        targets.delete(host);
        if (targets.size === 0) {
          observer.disconnect();
          documents.delete(document);
        } else if (!rebuildQueued) {
          // Native observers cannot unobserve one target. Preserve queued work
          // for retained providers before rebuilding once per removal batch.
          rebuildQueued = true;
          queueMicrotask(() => {
            rebuildQueued = false;
            deliver(observer.takeRecords());
            observer.disconnect();
            targets.forEach((_registrations, target) => observe(target));
          });
        }
      };
    },
  };
}

/** Watch provider islands without observing the document or crossing shadow roots. */
export function observeLinkReaderInline(host: HTMLElement, notify: () => void): () => void {
  const document = host.ownerDocument;
  let owner = documents.get(document);
  if (!owner) {
    owner = createInlineObserver(document);
    documents.set(document, owner);
  }
  return owner.register(host, notify);
}
