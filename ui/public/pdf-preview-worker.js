// PDF Blob documents inherit their creator's CSP. Keep this HTTP worker's
// response policy separate from the app's anti-framing policy.
let currentUrl;
self.addEventListener("message", ({ data }) => {
  if (data?.type === "dispose") {
    if (currentUrl) {
      URL.revokeObjectURL(currentUrl);
    }
    currentUrl = undefined;
    self.close();
    self.postMessage({ type: "disposed" }, []);
    return;
  }
  if (
    data?.type !== "show" ||
    !Number.isSafeInteger(data.generation) ||
    data.generation < 1 ||
    !(data.bytes instanceof ArrayBuffer) ||
    data.bytes.byteLength === 0 ||
    data.bytes.byteLength > 16 * 1024 * 1024
  ) {
    self.postMessage({ type: "error", generation: data?.generation }, []);
    return;
  }
  try {
    const next = URL.createObjectURL(new Blob([data.bytes], { type: "application/pdf" }));
    if (currentUrl) {
      URL.revokeObjectURL(currentUrl);
    }
    currentUrl = next;
    self.postMessage({ type: "shown", generation: data.generation, url: next }, []);
  } catch {
    self.postMessage({ type: "error", generation: data.generation }, []);
  }
});
self.postMessage({ type: "ready" }, []);
