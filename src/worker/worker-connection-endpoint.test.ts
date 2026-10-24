import { expect, it } from "vitest";
import {
  parseWorkerConnectionEndpoint as parseEndpoint,
  resolveWorkerConnectionTarget as resolveTarget,
  WORKER_CONNECTION_ENDPOINT_MAX_JSON_BYTES as maxJsonBytes,
  type WorkerConnectionEndpoint,
} from "./worker-connection-endpoint.js";

const fingerprint = "ab".repeat(32);
const colonFingerprint = (fingerprint.match(/.{2}/gu)?.join(":") ?? "").toUpperCase();
const websocket = { kind: "websocket" as const, url: "wss://gateway.example/__openclaw__/worker" };
const credentials = { clientId: "cf-worker-id", clientSecret: "cf-worker-secret" };
const plaintext = { ...websocket, url: "ws://127.0.0.1/__openclaw__/worker" };

it.each([
  { kind: "unix", socketPath: "/tmp/gateway:sock" },
  ...[
    "https://gateway.example/__openclaw__/worker",
    "ws://user@gateway.example/__openclaw__/worker",
    "wss://gateway.example/other",
    "wss://gateway.example/__openclaw__/worker?token=x",
  ].map((url) => Object.assign({}, websocket, { url })),
  { ...plaintext, tlsFingerprint: fingerprint },
  ...["", "ab:cd:ef", "g".repeat(64)].map((tlsFingerprint) =>
    Object.assign({}, websocket, { tlsFingerprint }),
  ),
  { ...websocket, unexpected: true },
])("rejects malformed or unsafe worker endpoint %j", (endpoint) => {
  expect(parseEndpoint(endpoint)).toBeUndefined();
});

function expectBounded(input: unknown) {
  const parsed = parseEndpoint(input);
  expect(parsed).toBeDefined();
  expect(Buffer.byteLength(JSON.stringify(parsed))).toBeLessThanOrEqual(maxJsonBytes);
}
function inherited(prototype: object, own: object): object {
  return Object.assign(Object.create(prototype), own);
}

it("bounds maximal control endpoint and Access fields", () => {
  const prefix = "wss://worker.invalid/";
  const suffix = "/__openclaw__/worker";
  const fill = (length: number) => "\0".repeat(length);
  const input = {
    kind: "websocket",
    url: prefix + fill(4_096 - prefix.length - suffix.length) + suffix,
    tlsFingerprint: colonFingerprint,
    cloudflareAccess: { clientId: `x${fill(4_095)}`, clientSecret: `s${fill(4_095)}` },
  };
  expectBounded(input);
  for (const key of ["url", "clientId", "clientSecret"] as const) {
    const candidate = structuredClone(input);
    if (key === "url") {
      candidate.url = prefix + "x" + input.url.slice(prefix.length);
    } else {
      candidate.cloudflareAccess[key] += "x";
    }
    expect(parseEndpoint(candidate)).toBeUndefined();
  }
  expectBounded({ kind: "unix", socketPath: `/${fill(255)}` });
});

it("rejects endpoint fields inherited from the prototype", () => {
  for (const endpoint of [
    inherited({ kind: "unix" }, { socketPath: "/tmp/openclaw-worker/gateway.sock" }),
    inherited({ tlsFingerprint: fingerprint }, websocket),
    {
      ...websocket,
      cloudflareAccess: inherited({ clientId: "fixture-id" }, { clientSecret: "fixture-secret" }),
    },
    {
      ...websocket,
      cloudflareAccess: inherited({ clientSecret: "fixture-secret" }, { clientId: "fixture-id" }),
    },
  ]) {
    expect(parseEndpoint(endpoint)).toBeUndefined();
  }
});

it("omits explicitly undefined optional credentials", () => {
  const input = { ...plaintext, tlsFingerprint: undefined, cloudflareAccess: undefined };
  expect(parseEndpoint(input)).toStrictEqual(plaintext);
});

it("carries the closed Cloudflare Access credential pair to the worker upgrade", () => {
  const endpoint = parseEndpoint({ ...websocket, cloudflareAccess: credentials });

  expect(endpoint).toBeDefined();
  expect(resolveTarget(endpoint!).options.headers).toEqual({
    "CF-Access-Client-Id": credentials.clientId,
    "CF-Access-Client-Secret": credentials.clientSecret,
  });
});

it("rejects public plaintext while retaining the private-network break-glass", () => {
  const endpoint = {
    ...websocket,
    url: "ws://gateway.example/__openclaw__/worker",
  };
  expect(() => resolveTarget(endpoint, {})).toThrow("SECURITY ERROR");
  expect(() => resolveTarget(endpoint, { OPENCLAW_ALLOW_INSECURE_PRIVATE_WS: "1" })).not.toThrow();
});

it("rejects Access credentials on plaintext worker endpoints", () => {
  const endpoint = { ...plaintext, cloudflareAccess: credentials };

  expect(parseEndpoint(endpoint)).toBeUndefined();
  expect(() => resolveTarget(endpoint as WorkerConnectionEndpoint)).toThrow(
    "Cloudflare Access credentials require a wss:// worker endpoint",
  );
});
