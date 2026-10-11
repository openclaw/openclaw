const view = (
  <section>
    <button onClick={() => window.open("https://example.com")}>Open in a test</button>
    <button onClick={() => plugin.registerHttpHandler(() => {})}>Register in a test</button>
  </section>
);
