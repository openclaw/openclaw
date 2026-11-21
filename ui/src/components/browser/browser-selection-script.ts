// Page function for Gateway Chromium: reads the text the user selected in the remote page.
export const browserSelectionScript = String.raw`function openclawReadBrowserSelection(limit, probeOnly) {
  // Follow focus into open shadow roots and same-origin frames; cross-origin frames stay unreachable.
  let doc = document;
  let active = doc.activeElement;
  for (let depth = 0; active && depth < 16; depth += 1) {
    if (active.shadowRoot && active.shadowRoot.activeElement) {
      active = active.shadowRoot.activeElement;
    } else if (active.contentDocument) {
      doc = active.contentDocument;
      active = doc.activeElement;
    } else {
      break;
    }
  }
  const field = active && (active.tagName === "TEXTAREA" || active.tagName === "INPUT");
  // Browsers refuse to copy password fields, and Chrome's getSelection() would expose them.
  if (field && active.type === "password") return { length: 0, text: "", truncated: false };
  let text = "";
  if (field && typeof active.selectionStart === "number") {
    // Chrome's page selection reads inside fields, but only the field range is exact.
    text = active.value.slice(active.selectionStart, active.selectionEnd);
  } else {
    const selection = doc.getSelection();
    text = selection ? selection.toString() : "";
  }
  const length = text.length;
  if (probeOnly || length === 0) return { length, text: "", truncated: false };
  if (length <= limit) return { length, text, truncated: false };
  // This serialized page function cannot call imported helpers; back up only when the cap splits a surrogate pair.
  const high = text.charCodeAt(limit - 1);
  return { length, text: text.slice(0, high >= 0xd800 && high <= 0xdbff ? limit - 1 : limit), truncated: true };
}`;
