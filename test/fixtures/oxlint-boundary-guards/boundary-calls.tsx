const view = (
  <section>
    <button onClick={() => window.open("https://example.com")}>Open</button>
    <button onClick={() => globalThis?.open?.("https://example.com")}>Open globally</button>
    <button onClick={() => plugin.registerHttpHandler(() => {})}>Register</button>
    <button onClick={() => openExternalUrlSafe("https://example.com")}>Open safely</button>
    <button onClick={() => plugin.registerHttpRoute({ path: "/example", handler })}>Route</button>
    <p>window.open("https://example.com")</p>
  </section>
);
