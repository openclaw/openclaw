type Registration = { attributes: readonly string[]; notify: () => void };
const roots = new WeakMap<Element, ReturnType<typeof createRootObserver>>();

function createRootObserver(root: Element) {
  const registrations = new Set<Registration>();
  const observedAttributes = new Set<string>();
  const observer = new MutationObserver((records) => {
    const changed = new Set(records.map((record) => record.attributeName));
    const affected = [...registrations].filter((registration) =>
      registration.attributes.some((attribute) => changed.has(attribute)),
    );
    for (const registration of affected) {
      if (registrations.has(registration)) {
        try {
          registration.notify();
        } catch (error) {
          // Preserve native callback isolation between independent theme consumers.
          reportError(error);
        }
      }
    }
  });
  return {
    subscribe(attributes: readonly string[], notify: () => void) {
      const registration = { attributes, notify };
      registrations.add(registration);
      let expanded = false;
      for (const attribute of attributes) {
        if (!observedAttributes.has(attribute)) {
          observedAttributes.add(attribute);
          expanded = true;
        }
      }
      if (expanded) {
        // Re-observing preserves pending records. Keep this small filter superset
        // until the last consumer leaves instead of reconfiguring on row removal.
        observer.observe(root, { attributes: true, attributeFilter: [...observedAttributes] });
      }
      return () => {
        if (registrations.delete(registration) && registrations.size === 0) {
          observer.disconnect();
          roots.delete(root);
        }
      };
    },
  };
}

/** Root-only invalidation; consumers retain their own theme reads and rendering. */
export function observeDocumentRootAttributes(
  document: Document,
  attributes: readonly string[],
  notify: () => void,
) {
  const root = document.documentElement;
  let observation = roots.get(root);
  if (!observation) {
    observation = createRootObserver(root);
    roots.set(root, observation);
  }
  return observation.subscribe(attributes, notify);
}
