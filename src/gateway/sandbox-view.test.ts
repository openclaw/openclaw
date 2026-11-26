import { afterEach, expect, it } from "vitest";
import vectors from "../../test/fixtures/openclaw-id/sandbox-host-vectors.json" with { type: "json" };
import { setOpenClawIdClawOriginResolver } from "./openclaw-id/claw-origin.js";
import { resolveSandboxView } from "./sandbox-view.js";
import { makeClient } from "./server-broadcast.test-helpers.js";

afterEach(() => setOpenClawIdClawOriginResolver(undefined));

function viewForOrigin(origin: string) {
  setOpenClawIdClawOriginResolver(() => origin);
  const { client } = makeClient("sandbox-view", "operator", ["operator.read"]);
  client.browserOrigin = { openclawIdTunnel: true };
  return resolveSandboxView("/mcp-app-sandbox", client);
}

it.each(vectors.filter(({ name }) => name !== "test-host-with-port"))(
  "maps $name to its fixed-length production sandbox URL",
  ({ clawHost, sandboxLabel }) => {
    const result = viewForOrigin(`https://${clawHost}`);
    const url = new URL(result.sandboxUrl);
    const separator = clawHost.indexOf(".");
    const sandboxHost = sandboxLabel + clawHost.slice(separator).toLowerCase();
    expect(url.host).toBe(sandboxHost);
    expect(url.hostname.split(".")[0]).toHaveLength(37);
    expect(url.origin).toBe(`https://${sandboxHost}`);
    expect(result.sandboxOrigin).toBe(url.origin);
    expect(url.pathname).toBe("/mcp-app-sandbox");
    expect(url.searchParams.get("claw")).toBe(clawHost.slice(0, separator).toLowerCase());
    expect(url.searchParams.get("cspv")).toBe("1");
    expect(result.sandboxShellHtml).toContain("ui/notifications/sandbox-proxy-ready");
  },
);

// Allowlisted loopback hosts share only the hash vector. The loader testbed supplies
// its configured sandbox domain and full-host claw query, not a signed Gateway binding.
it.each(vectors.filter(({ name }) => name === "test-host-with-port"))(
  "hashes the complete $name input including its port",
  ({ clawHost, sandboxLabel }) => {
    const result = viewForOrigin(`http://${clawHost}`);
    expect(new URL(result.sandboxUrl).hostname.split(".")[0]).toBe(sandboxLabel);
  },
);
