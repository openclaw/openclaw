import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";

const probeHeader = "x-openclaw-e2e-probe";
const isolationGuidance =
  "Use the documented secretless UI E2E launcher when the execution environment restricts loopback HTTP; do not disable its proxy policy.";

type PreflightOptions = {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

/** Prove transport before a project acquires a Gateway or UI build. */
export async function assertUiE2ePreflight({
  fetchImpl = fetch,
  timeoutMs = 5_000,
}: PreflightOptions = {}): Promise<void> {
  const nonce = randomUUID();
  let received = false;
  const server = createServer((request, response) => {
    if (request.method === "GET" && request.url === "/ui-e2e-preflight") {
      received = true;
      response.writeHead(204, { [probeHeader]: nonce });
    } else {
      response.writeHead(404);
    }
    response.end();
  });
  let status: number | undefined;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref();
  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening", { signal: controller.signal });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Loopback server did not bind");
    }
    const response = await fetchImpl("http://127.0.0.1:" + address.port + "/ui-e2e-preflight", {
      signal: controller.signal,
      redirect: "error",
    });
    status = response.status;
    const matches = response.status === 204 && response.headers.get(probeHeader) === nonce;
    await response.body?.cancel();
    if (!received || !matches) {
      throw new Error("Loopback response did not come from the owned server");
    }
  } catch {
    const detail = controller.signal.aborted
      ? "timed out"
      : status === undefined
        ? "transport failed"
        : "received HTTP " + status + " instead of the owned response";
    // Transport failures can contain proxy credentials or arbitrary remote bodies.
    throw new Error("UI E2E loopback HTTP preflight " + detail + ". " + isolationGuidance);
  } finally {
    clearTimeout(timer);
    controller.abort();
    server.closeAllConnections();
    if (server.listening) {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  }
}
