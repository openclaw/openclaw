// This script must execute before plugin-owned code in the parent-fetched
// srcdoc. Document liveness uses an endpoint never exposed to plugin code.
(() => {
  const script = document.currentScript;
  const nonce = script?.getAttribute("data-openclaw-plugin-ui-nonce");
  script?.removeAttribute("data-openclaw-plugin-ui-nonce");
  if (!nonce || window.parent === window || Object.hasOwn(window, "openclawPluginUiBridge")) {
    return;
  }

  const parent = window.parent;
  const postToParent = parent.postMessage.bind(parent);
  const channel = new MessageChannel();
  const documentChannel = new MessageChannel();
  const postDocumentProof = documentChannel.port1.postMessage.bind(documentChannel.port1);
  documentChannel.port1.addEventListener("message", (event) => {
    if (event.data?.v === 1 && event.data.type === "openclaw.pluginUi.verifyDocument") {
      // Window-owned port tasks cannot run after their document is replaced.
      // Keep this responder private; the public action port may be delegated.
      postDocumentProof({
        v: 1,
        type: "openclaw.pluginUi.documentVerified",
        id: event.data.id,
      });
    }
  });
  documentChannel.port1.start();
  let resolveConnection;
  const connected = new Promise((resolve) => {
    resolveConnection = resolve;
  });
  Object.defineProperty(window, "openclawPluginUiBridge", {
    value: Object.freeze({ connected }),
    writable: false,
    configurable: false,
  });
  channel.port1.addEventListener("message", (event) => {
    if (event.data?.v === 1 && event.data.type === "openclaw.pluginUi.connect") {
      resolveConnection?.({ port: channel.port1, connection: event.data });
      resolveConnection = undefined;
    }
  });
  channel.port1.start();
  postToParent({ v: 1, type: "openclaw.pluginUi.ready", nonce }, "*", [
    channel.port2,
    documentChannel.port2,
  ]);
})();
