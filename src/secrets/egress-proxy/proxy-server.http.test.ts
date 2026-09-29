import { execFile } from "node:child_process";
import { once } from "node:events";
import { createServer, request as httpRequest, type Server } from "node:http";
import { promisify } from "node:util";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { mintSecretSentinel } from "../sentinel.js";
import {
  startSecretEgressProxyServer,
  type SecretEgressProxyAuditEvent,
  type SecretEgressProxyHandle,
} from "./proxy-server.js";

const tempDirs = useAutoCleanupTempDirTracker(afterAll);
const servers: Server[] = [];
const proxies: SecretEgressProxyHandle[] = [];
const audit: SecretEgressProxyAuditEvent[] = [];
const observed: Array<{ url: string | undefined; body: string; port: number | undefined }> = [];
let proxy: SecretEgressProxyHandle;
let lockdown: SecretEgressProxyHandle;
let allowed: SecretEgressProxyHandle;
let bypass: SecretEgressProxyHandle;
let port: number;
let ipv6Port: number;

async function listen(host: string): Promise<number> {
  const server = createServer((incoming, response) => {
    const chunks: Buffer[] = [];
    incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
    incoming.on("end", () => {
      observed.push({
        url: incoming.url,
        body: Buffer.concat(chunks).toString(),
        port: incoming.socket.remotePort,
      });
      response.end("loopback-ok");
    });
  });
  servers.push(server);
  server.listen(0, host);
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("HTTP fixture did not bind a TCP port");
  }
  return address.port;
}

beforeAll(async () => {
  const caDir = tempDirs.make("openclaw-egress-http-");
  const start = async (options: { allowedHosts?: string[]; bypassHosts?: string[] } = {}) => {
    const result = await startSecretEgressProxyServer({
      caDir,
      ...options,
      onAudit: (event) => audit.push(event),
    });
    proxies.push(result);
    return result;
  };
  proxy = await start();
  lockdown = await start({ allowedHosts: [] });
  allowed = await start({ allowedHosts: ["localhost"] });
  bypass = await start({ allowedHosts: [], bypassHosts: ["localhost"] });
  port = await listen("127.0.0.1");
  ipv6Port = await listen("::1");
});

beforeEach(() => {
  audit.length = 0;
  observed.length = 0;
});

afterAll(async () => {
  for (const current of proxies) {
    await current.stop();
  }
  for (const server of servers) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }
});

async function request(
  params: {
    target?: string;
    env?: Record<string, string>;
    authenticated?: boolean;
    headers?: Record<string, string>;
    chunks?: string[];
  } = {},
): Promise<{ status: number; body: string }> {
  const env = params.env ?? proxy.registerProcess().env;
  const endpoint = new URL(env.HTTP_PROXY!);
  return await new Promise((resolve, reject) => {
    const outgoing = httpRequest(
      {
        hostname: endpoint.hostname,
        port: endpoint.port,
        path: params.target ?? `http://localhost:${port}/ok`,
        method: params.chunks ? "POST" : "GET",
        agent: false,
        headers: {
          ...(params.authenticated === false
            ? {}
            : {
                "Proxy-Authorization": `Basic ${Buffer.from(`openclaw:${endpoint.password}`).toString("base64")}`,
              }),
          ...params.headers,
        },
      },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          body += chunk;
        });
        response.once("error", reject);
        response.once("end", () => resolve({ status: response.statusCode ?? 0, body }));
      },
    );
    outgoing.once("error", reject);
    for (const chunk of params.chunks ?? []) {
      outgoing.write(chunk);
    }
    outgoing.end();
  });
}

// Node's HTTP client honors NODE_USE_ENV_PROXY and uses absolute-form HTTP forwarding.
// fetch's CONNECT transport exercises a different proxy entry point.
const CHILD_REQUEST = `
  const http = require('node:http');
  let port;
  const request = http.get(process.argv[1], response => {
    let body = '';
    response.setEncoding('utf8');
    response.on('data', chunk => body += chunk);
    response.on('end', () => console.log(JSON.stringify({ status: response.statusCode, body, port })));
  });
  request.on('socket', socket => socket.on('connect', () => { port = socket.localPort; }));
  request.on('error', error => { console.error(error.message); process.exitCode = 1; });
`;

describe("secret egress plain HTTP", () => {
  it.each(["localhost", "127.0.0.1", "[::1]"])(
    "forwards literal loopback %s with an audit",
    async (host) => {
      expect(
        await request({ target: `http://${host}:${host === "[::1]" ? ipv6Port : port}/ok` }),
      ).toEqual({ status: 200, body: "loopback-ok" });
      expect(observed).toHaveLength(1);
      expect(observed[0]?.url).toBe("/ok");
      expect(audit).toEqual([
        { kind: "forwarded", host: host === "[::1]" ? "::1" : host, substituted: false },
      ]);
    },
  );

  it.each(["example.com", "localhost.example.com", "128.0.0.1", "[::2]"])(
    "refuses non-loopback plain HTTP to %s",
    async (host) => {
      expect(await request({ target: `http://${host}/ok` })).toEqual({
        status: 502,
        body: "Secret egress proxy refused the request.\n",
      });
      expect(observed).toEqual([]);
      expect(audit).toEqual([
        expect.objectContaining({ kind: "refused", reason: "non-https-request" }),
      ]);
    },
  );

  it("requires grant authentication on loopback HTTP", async () => {
    expect(await request({ authenticated: false })).toMatchObject({ status: 407 });
    expect(observed).toEqual([]);
    expect(audit).toEqual([
      { kind: "refused", host: "localhost", substituted: false, reason: "missing-proxy-auth" },
    ]);
  });

  it.each(["url", "header", "fixed-length", "chunked"] as const)(
    "refuses a loopback HTTP sentinel in the %s",
    async (location) => {
      const sentinel = mintSecretSentinel("synthetic-http-secret", { label: "http-refusal" });
      const grant = proxy.registerProcess([
        { name: "SERVICE_API_KEY", sentinel, allowedHosts: ["localhost"] },
      ]);
      try {
        const body = location === "fixed-length" || location === "chunked";
        expect(
          await request({
            env: grant.env,
            target: `http://localhost:${port}/ok${location === "url" ? `?key=${sentinel}` : ""}`,
            headers:
              location === "header"
                ? { Authorization: `Bearer ${sentinel}` }
                : location === "fixed-length"
                  ? { "Content-Length": String(sentinel.length) }
                  : undefined,
            chunks: body ? [sentinel.slice(0, 8), sentinel.slice(8)] : undefined,
          }),
        ).toEqual({ status: 502, body: "Secret egress proxy refused the request.\n" });
        expect(observed).toEqual([]);
        expect(audit).toEqual([
          { kind: "refused", host: "localhost", substituted: false, reason: "non-https-request" },
        ]);
      } finally {
        grant.revoke();
      }
    },
  );

  it("keeps allowlisted, bound and bypass hosts reachable under HTTP lockdown", async () => {
    const sentinel = mintSecretSentinel("synthetic-bound-secret", { label: "http-binding" });
    const grants = [
      allowed.registerProcess(),
      bypass.registerProcess(),
      lockdown.registerProcess([
        { name: "SERVICE_API_KEY", sentinel, allowedHosts: ["localhost"] },
      ]),
    ];
    try {
      for (const grant of grants) {
        expect(await request({ env: grant.env })).toEqual({ status: 200, body: "loopback-ok" });
      }
      expect(observed).toHaveLength(3);
      expect(audit).toEqual(
        Array.from({ length: 3 }, () => ({
          kind: "forwarded",
          host: "localhost",
          substituted: false,
        })),
      );
    } finally {
      for (const grant of grants) {
        grant.revoke();
      }
    }
  });

  it.each([false, true])(
    "routes a real child through the proxy (lockdown: %s)",
    async (restricted) => {
      const grant = (restricted ? lockdown : proxy).registerProcess();
      try {
        const result = await promisify(execFile)(
          process.execPath,
          ["-e", CHILD_REQUEST, `http://127.0.0.1:${port}/ok`],
          {
            env: { SystemRoot: process.env.SystemRoot, ...grant.env },
          },
        );
        const response = JSON.parse(result.stdout);
        expect(response.status).toBe(restricted ? 403 : 200);
        if (restricted) {
          expect(response.body).toBe(
            'Host "127.0.0.1" is not in the secret egress proxy traffic allowlist. Add it to secrets.egressProxy.allowedHosts or bind a store secret to it with: openclaw secrets store set <NAME> --allow-host 127.0.0.1, then restart the Gateway.\n',
          );
          expect(observed).toEqual([]);
          expect(audit).toEqual([
            { kind: "refused", host: "127.0.0.1", substituted: false, reason: "host-not-allowed" },
          ]);
        } else {
          expect(response.body).toBe("loopback-ok");
          expect(observed).toHaveLength(1);
          expect(observed[0]?.port).toBeTypeOf("number");
          expect(response.port).toBeTypeOf("number");
          expect(observed[0]?.port).not.toBe(response.port);
          expect(audit).toEqual([{ kind: "forwarded", host: "127.0.0.1", substituted: false }]);
        }
      } finally {
        grant.revoke();
      }
    },
  );
});
