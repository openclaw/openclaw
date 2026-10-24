import { expect, it, vi } from "vitest";
import {
  extractTailscaleServeGatewayUrls,
  inspectTailscaleServeGatewayUrlsWithRunner as inspectServe,
  resolveTailnetHostWithRunner,
  resolveTailscalePublishedHost,
  resolveTailscaleServeGatewayUrlsWithRunner as resolveServe,
} from "./tailscale-status.js";

const handler = (Proxy: string, path = "/") => ({ Handlers: { [path]: { Proxy } } });
const result = (value: unknown) => ({ code: 0, stdout: JSON.stringify(value) });
const runner = (value: unknown) => vi.fn().mockResolvedValue(result(value));
const serve = (routes: [host: string, proxy: string, path?: string][], ports = [443]) => ({
  TCP: Object.fromEntries(ports.map((port) => [port, { HTTPS: true }])),
  Web: Object.fromEntries(routes.map(([host, proxy, path]) => [host, handler(proxy, path)])),
});

it("keeps the deprecated named-Service formatter for shipped plugin SDK callers", () => {
  expect(
    resolveTailscalePublishedHost({
      tailscaleMode: "serve",
      tailnetHost: "node.tailnet.ts.net",
      serviceName: "svc:openclaw",
    }),
  ).toBe("openclaw.tailnet.ts.net");
});

it.each([
  [
    () => Promise.reject(new Error("missing binary")),
    { TailscaleIPs: ["100.64.0.9", "fd7a::1"] },
    "100.64.0.9",
  ],
  [
    () => Promise.resolve(result({ Self: {} })),
    { DNSName: "backup.tail.ts.net." },
    "backup.tail.ts.net",
  ],
] as const)("falls back to host %#", async (first, Self, expected) => {
  const run = vi.fn().mockImplementationOnce(first).mockResolvedValueOnce(result({ Self }));
  await expect(resolveTailnetHostWithRunner(run)).resolves.toBe(expected);
  expect(run).toHaveBeenCalledTimes(2);
  expect(run).toHaveBeenNthCalledWith(
    2,
    ["/Applications/Tailscale.app/Contents/MacOS/Tailscale", "status", "--json"],
    { timeoutMs: 5000 },
  );
});

it.each([
  undefined,
  { code: null, stdout: "boom" },
  { code: 1, stdout: "boom" },
  { code: 0, stdout: "   " },
  { code: 0, stdout: "not-json" },
])("returns null for unavailable or invalid status %j", async (commandResult) => {
  const run = commandResult && vi.fn().mockResolvedValue(commandResult);
  await expect(resolveTailnetHostWithRunner(run)).resolves.toBeNull();
});

it.each(["localhost:18789", "18789"])("discovers SDK proxy %s without ownership", async (proxy) => {
  const config = serve(
    [
      ["mac.tail.ts.net:443", "http://127.0.0.1:8096"],
      ["mac.tail.ts.net:8443", proxy],
    ],
    [443, 8443],
  );
  const run = runner(config);

  await expect(resolveServe(18789, run)).resolves.toEqual(["wss://mac.tail.ts.net:8443"]);
  expect(run).toHaveBeenCalledWith(["tailscale", "serve", "status", "--json"], {
    timeoutMs: 5000,
  });
});

it("ignores non-root, non-HTTPS, and non-loopback Serve handlers", async () => {
  const run = runner({
    ...serve([
      ["mac.tail.ts.net:80", "http://127.0.0.1:18789"],
      ["mac.tail.ts.net:443", "http://127.0.0.1:18789", "/openclaw"],
      ["other.tail.ts.net:443", "http://192.168.1.20:18789"],
    ]),
    TCP: { "80": { HTTP: true }, "443": { HTTPS: true } },
  });

  await expect(resolveServe(18789, run)).resolves.toEqual([]);
});

it("ignores load-balanced Tailscale Services and public Funnel routes", async () => {
  const run = runner({
    ...serve([["mac.tail.ts.net:443", "127.0.0.1:18789"]]),
    AllowFunnel: { "mac.tail.ts.net:443": true },
    Services: {
      "svc:openclaw": serve([["openclaw.tail.ts.net:443", "127.0.0.1:18789"]]),
    },
  });

  await expect(resolveServe(18789, run)).resolves.toEqual([]);
});

it.each([
  [8443, "http://127.0.0.1:8096"],
  [443, "https://127.0.0.1:18789"],
  [443, "http://127.0.0.1:18789/api"],
  [443, "http://127.0.0.1:18789/?other"],
  [443, "http://192.0.2.1:18789"],
])("rejects ownership of HTTPS port %s targeting %s", (httpsPort, proxy) => {
  const host = `fixture.tail.ts.net:${httpsPort}`;
  const raw = JSON.stringify({
    ...serve([[host, proxy]], [httpsPort]),
    AllowFunnel: { [host]: true },
  });
  expect(extractTailscaleServeGatewayUrls(raw, 18789, true)).toEqual([]);
});

it.each([
  [443, false],
  [8443, true],
])(
  "requires HTTPS port 443 to be exclusive across hostnames (sibling port %s)",
  (siblingPort, owned) => {
    const url = "wss://old.tail.ts.net";
    const config = serve(
      [
        ["old.tail.ts.net:443", "http://127.0.0.1:18789"],
        [`current.tail.ts.net:${siblingPort}`, "http://127.0.0.1:8096"],
      ],
      [443, siblingPort],
    );
    const raw = JSON.stringify(config);
    expect(extractTailscaleServeGatewayUrls(raw, 18789, true)).toEqual(owned ? [url] : []);
    expect(extractTailscaleServeGatewayUrls(raw, 18789)).toEqual([url]);
  },
);

it("distinguishes malformed Serve status from an empty valid configuration", async () => {
  const bad = vi.fn().mockResolvedValue({ code: 0, stdout: "not-json" });
  const empty = runner({});
  await expect(inspectServe(18789, bad)).resolves.toEqual({ status: "invalid" });
  await expect(inspectServe(18789, empty)).resolves.toEqual({ status: "ok", urls: [] });
  await expect(resolveServe(18789, bad)).resolves.toEqual([]);
});
