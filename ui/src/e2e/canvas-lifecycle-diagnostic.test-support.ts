import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import type { Page, Request, Response, WebSocket } from "playwright";

type CanvasRead = { completed: boolean; ok?: boolean; html?: boolean; sandboxUrl?: boolean };

/** Keep failure facts in normal CI logs without publishing private browser artifacts. */
export async function withCanvasFailureDiagnostics<T>(
  page: Page,
  run: () => Promise<T>,
): Promise<T> {
  const sandbox = { requests: 0, statuses: [] as number[], failures: 0 };
  const reads = new Map<string, CanvasRead>();
  const isSandbox = (url: string) => new URL(url).pathname === "/mcp-app-sandbox";
  const request = (value: Request) => {
    if (isSandbox(value.url())) {
      sandbox.requests += 1;
    }
  };
  const response = (value: Response) => {
    if (isSandbox(value.url()) && sandbox.statuses.length < 8) {
      sandbox.statuses.push(value.status());
    }
  };
  const failed = (value: Request) => {
    if (isSandbox(value.url())) {
      sandbox.failures += 1;
    }
  };
  const websocket = (socket: WebSocket) => {
    socket.on("framesent", ({ payload }) => {
      try {
        const data = asOptionalRecord(JSON.parse(payload.toString()));
        if (
          data?.method === "canvas.document.view" &&
          typeof data.id === "string" &&
          reads.size < 8
        ) {
          reads.set(data.id, { completed: false });
        }
      } catch {
        // Unrelated binary/non-JSON frames are not diagnostic inputs.
      }
    });
    socket.on("framereceived", ({ payload }) => {
      try {
        const data = asOptionalRecord(JSON.parse(payload.toString()));
        const read = typeof data?.id === "string" ? reads.get(data.id) : undefined;
        if (read) {
          const result = asOptionalRecord(data?.payload);
          Object.assign(read, {
            completed: true,
            ok: data?.ok === true,
            html: typeof result?.html === "string",
            sandboxUrl: typeof result?.sandboxUrl === "string",
          });
        }
      } catch {
        // Never include arbitrary transport content or error strings in CI.
      }
    });
  };
  page.on("request", request);
  page.on("response", response);
  page.on("requestfailed", failed);
  page.on("websocket", websocket);
  try {
    return await run();
  } catch (error) {
    let widgets: unknown = { unavailable: true };
    try {
      widgets = await page.locator("openclaw-canvas-widget-view").evaluateAll((elements) => {
        const field = (value: unknown, key: string): unknown =>
          value !== null && typeof value === "object" ? Reflect.get(value, key) : undefined;
        const generation = (value: unknown) =>
          typeof value === "number" && Number.isSafeInteger(value) ? value : null;
        return elements.slice(0, 8).map((element) => {
          const binding = Reflect.get(element, "binding");
          const host = Reflect.get(element, "sandboxHost");
          const view = Reflect.get(element, "view");
          const frame = element.querySelector("iframe");
          return {
            connected: element.isConnected,
            generation: generation(Reflect.get(element, "connectionGeneration")),
            bindingGeneration: generation(field(binding, "generation")),
            hasHtml: typeof field(view, "html") === "string",
            hasError: Boolean(Reflect.get(element, "error")),
            scriptsAllowed: Reflect.get(element, "allowScripts") === true,
            hasFrame: Boolean(frame),
            strictFrame: frame?.hasAttribute("srcdoc") ?? false,
            hostReady: field(host, "ready") === true,
            hostLoaded: field(host, "loaded") === true,
          };
        });
      });
    } catch {
      // A closed page must not replace the original assertion failure.
    }
    // No document IDs, URLs, HTML, credentials, page text, or arbitrary errors.
    console.error(
      "[canvas-ci] failure stages",
      JSON.stringify({ sandbox, reads: [...reads.values()], widgets }),
    );
    throw error;
  } finally {
    page.off("request", request);
    page.off("response", response);
    page.off("requestfailed", failed);
    page.off("websocket", websocket);
  }
}
