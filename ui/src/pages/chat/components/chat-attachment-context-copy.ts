type AttachmentContextCopy = { name: string; href?: string };

const attachmentContextCopies = new WeakMap<Element, () => AttachmentContextCopy | null>();

/** The renderer supplies current copy facts without copying its state or reading its DOM. */
export function attachmentContextCopyRef(read: () => AttachmentContextCopy | null) {
  return (element: Element) => {
    attachmentContextCopies.set(element, read);
  };
}

export function readAttachmentContextCopy(element: Element): AttachmentContextCopy | null {
  return attachmentContextCopies.get(element)?.() ?? null;
}
