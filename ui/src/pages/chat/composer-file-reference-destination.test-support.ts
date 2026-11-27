import { readFileReferenceDestination } from "../../lib/chat/file-reference-destination.ts";
import {
  updateComposerFileReferences,
  type ComposerFileReference,
} from "../../lib/chat/file-references.ts";
import { mountMentionComposerEditor } from "./components/composer-editor-mentions.tsx";

let mountedFixtures = 0;
const geometryFallbacks = new Map<string, PropertyDescriptor | undefined>();

export function acquireMissingGeometry() {
  mountedFixtures += 1;
  for (const [key, value] of Object.entries({
    getClientRects: () => Object.assign([], { item: () => null }),
    getBoundingClientRect: () => new DOMRect(),
  })) {
    if (!(key in Range.prototype)) {
      geometryFallbacks.set(key, Object.getOwnPropertyDescriptor(Range.prototype, key));
      Object.defineProperty(Range.prototype, key, { value, configurable: true });
    }
  }
  return () => {
    mountedFixtures -= 1;
    if (mountedFixtures) {
      return;
    }
    for (const [key, descriptor] of geometryFallbacks) {
      if (descriptor) {
        Object.defineProperty(Range.prototype, key, descriptor);
      } else {
        Reflect.deleteProperty(Range.prototype, key);
      }
    }
    geometryFallbacks.clear();
  };
}

/** Actual editor + synchronous input owner; provider admission belongs to the caller's fixture. */
export function createFileReferenceDestinationFixture(
  initialText = "",
  initialReferences: readonly ComposerFileReference[] = [],
) {
  // jsdom has no layout. Browser runs retain native geometry and prove it separately.
  const releaseGeometry = acquireMissingGeometry();
  const parent = document.createElement("div");
  const input = document.createElement("textarea");
  parent.append(input);
  document.body.append(parent);
  input.value = initialText;
  let text = initialText;
  let references = initialReferences;
  let onEdit: (() => void) | undefined;
  let disposed = false;
  const changed = () => {
    references = updateComposerFileReferences(text, input.value, references);
    text = input.value;
    onEdit?.();
  };
  input.addEventListener("input", changed);
  const mount = () =>
    mountMentionComposerEditor(
      input,
      () => [],
      undefined,
      undefined,
      undefined,
      () => references,
    );
  let editor = mount();
  return {
    input,
    get text() {
      return text;
    },
    get references() {
      return references;
    },
    get destination() {
      const destination = readFileReferenceDestination(input);
      if (!destination) {
        throw new Error("Actual file reference destination did not mount");
      }
      return destination;
    },
    onEdit(listener: () => void) {
      onEdit = listener;
    },
    externalEdit(value: string, nextReferences: readonly ComposerFileReference[] = []) {
      text = value;
      references = nextReferences;
      input.value = value;
      editor.sync();
      onEdit?.();
    },
    remount() {
      editor.destroy();
      editor = mount();
    },
    dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      input.removeEventListener("input", changed);
      editor.destroy();
      parent.remove();
      releaseGeometry();
    },
  };
}
