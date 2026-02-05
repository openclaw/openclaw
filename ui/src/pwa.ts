if (import.meta.env.PROD && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    const baseUrl = new URL(import.meta.env.BASE_URL, window.location.href);
    const scope = baseUrl.pathname.endsWith("/") ? baseUrl.pathname : `${baseUrl.pathname}/`;
    const swUrl = new URL("sw.js", baseUrl);

    navigator.serviceWorker.register(swUrl, { scope }).catch((error) => {
      console.warn("Service worker registration failed", error);
    });
  });
}
