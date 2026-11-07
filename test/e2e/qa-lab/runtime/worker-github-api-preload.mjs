// Replace only external GitHub API transport. Admission, credential verification,
// publication identity, grant creation and worker installation remain production.
const fixture = new URL(new URL(import.meta.url).searchParams.get("fixture"));
if (fixture.protocol !== "https:" || fixture.hostname !== "127.0.0.1") {
  throw new Error("GitHub transport fixture must be task-owned loopback HTTPS");
}
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : input);
  if (url.origin !== "https://api.github.com") {
    return originalFetch(input, init);
  }
  const target = new URL(`${url.pathname}${url.search}`, fixture);
  return originalFetch(input instanceof Request ? new Request(target, input) : target, init);
};
