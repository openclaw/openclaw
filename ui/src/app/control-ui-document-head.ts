type ControlUiDocumentHead = {
  readonly themeColors: readonly HTMLMetaElement[];
  readonly favicons: readonly HTMLLinkElement[];
};

let elements: ControlUiDocumentHead = { themeColors: [], favicons: [] };

/** The document entrypoint binds its static head nodes before mounting the app. */
export function bindControlUiDocumentHead(head: ControlUiDocumentHead): void {
  elements = head;
}

export function controlUiDocumentHead(): ControlUiDocumentHead {
  return elements;
}
