import { expect, it, onTestFinished, vi } from "vitest";
import { loadMcpAppSandbox } from "./mcp-app-frame.ts";
import { resolveSandboxHostUrl } from "./sandbox-host.ts";

it("accepts the sibling sandbox and waits for its authenticated bootstrap and proxy messages", async () => {
  const origin = "https://sbx--5hc3teeyegqctvmnit76geymerpsvbtq.crabd.xyz";
  const parent = "https://studio-k7x2q.crabd.xyz";
  const url = resolveSandboxHostUrl(
    "/mcp-app-sandbox?claw=studio-k7x2q&cspv=1",
    18790,
    origin,
    parent,
    parent,
  );
  const frame = document.createElement("iframe");
  document.body.append(frame);
  onTestFinished(() => frame.remove());
  const cleanups: Array<() => void> = [];
  onTestFinished(() => cleanups.forEach((cleanup) => cleanup()));
  const ready = vi.fn();
  const shell = "<p>Trusted shell</p>";
  const pending = loadMcpAppSandbox(
    frame,
    url,
    (cleanup) => {
      cleanups.push(cleanup);
      return cleanup;
    },
    shell,
  ).then(ready);
  const post = vi.spyOn(frame.contentWindow!, "postMessage");
  const notify = (method: string, source = frame.contentWindow, sender = origin, version = 1) =>
    window.dispatchEvent(
      new MessageEvent("message", {
        source,
        origin: sender,
        data: { method: "ui/notifications/sandbox-" + method, params: { version } },
      }),
    );
  notify("bootstrap-ready", window);
  notify("bootstrap-ready", frame.contentWindow, "https://other.example");
  notify("bootstrap-ready", frame.contentWindow, origin, 2);
  notify("proxy-ready", window);
  notify("proxy-ready", frame.contentWindow, "https://other.example");
  await Promise.resolve();
  expect(ready).not.toHaveBeenCalled();
  expect(post).not.toHaveBeenCalled();
  notify("bootstrap-ready");
  expect(post).toHaveBeenCalledExactlyOnceWith(
    { jsonrpc: "2.0", method: "ui/notifications/sandbox-bootstrap-shell", params: { html: shell } },
    origin,
  );
  expect(ready).not.toHaveBeenCalled();
  notify("proxy-ready");
  await pending;
  expect(ready).toHaveBeenCalledOnce();
});
