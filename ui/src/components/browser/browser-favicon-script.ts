// Page function serialized into native WebKit reading tabs.
export const browserFaviconScript = String.raw`async function openclawReadBrowserFavicon(maxBytes, timeoutMs) {
  let timeout;
  try {
    const controller = new AbortController();
    timeout = setTimeout(() => controller.abort(), timeoutMs);
    const icons = Array.from(document.querySelectorAll('link[rel~="icon"]'))
      .filter((link) => link.getAttribute("href")?.trim());
    const preferred = icons.find((link) => /(?:^|\s)32x32(?:\s|$)/i.test(link.getAttribute("sizes") || ""));
    const candidates = [
      ...(preferred ? [preferred.href] : []),
      ...icons.filter((link) => link !== preferred).map((link) => link.href),
      ...Array.from(document.querySelectorAll('link[rel="apple-touch-icon"]'))
        .filter((link) => link.getAttribute("href")?.trim()).map((link) => link.href),
      new URL("/favicon.ico", location.href).href,
    ];
    for (const url of new Set(candidates)) {
      if (controller.signal.aborted) return null;
      try {
        const response = await fetch(url, { credentials: "same-origin", mode: "cors", signal: controller.signal });
        if (!response.ok) continue;
        const blob = await response.blob();
        const mime = blob.type.split(";")[0].trim().toLowerCase();
        if (!/^image\/[a-z0-9.+-]+$/.test(mime) || blob.size > maxBytes) continue;
        const dataUrl = await new Promise((resolve) => {
          const reader = new FileReader();
          const finish = (value) => {
            controller.signal.removeEventListener("abort", abort);
            resolve(value);
          };
          const abort = () => { reader.abort(); finish(null); };
          reader.onload = () => finish(typeof reader.result === "string" ? reader.result : null);
          reader.onerror = reader.onabort = () => finish(null);
          controller.signal.addEventListener("abort", abort, { once: true });
          if (controller.signal.aborted) { abort(); return; }
          reader.readAsDataURL(blob);
        });
        if (dataUrl) {
          const b64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
          if (b64) return "data:" + mime + ";base64," + b64;
        }
      } catch {
        // A page may advertise an unavailable or cross-origin icon; try the next candidate.
      }
    }
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
  return null;
}`;
