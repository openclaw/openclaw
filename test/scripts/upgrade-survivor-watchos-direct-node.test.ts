import { execFile, execFileSync } from "node:child_process";
import crypto from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:https";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const execFileAsync = promisify(execFile);
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const adapter = resolve("scripts/e2e/lib/upgrade-survivor/watchos-direct-node.mjs");

function writeJson(file: string, value: unknown) {
  writeFileSync(file, JSON.stringify(value));
}

function createTlsFixture(root: string) {
  const tlsRoot = join(root, "tls");
  const caKey = join(tlsRoot, "ca-key.pem");
  const caCert = join(tlsRoot, "ca-cert.pem");
  const serverKey = join(tlsRoot, "server-key.pem");
  const serverCsr = join(tlsRoot, "server.csr");
  const serverCert = join(tlsRoot, "server-cert.pem");
  const serverExt = join(tlsRoot, "server.ext");
  mkdirSync(tlsRoot);
  const openssl = (command: string, options: Record<string, string | string[] | true>) => {
    const args = Object.entries(options).flatMap(([key, value]) =>
      value === true ? ["-" + key] : [value].flat().flatMap((item) => ["-" + key, item]),
    );
    execFileSync("openssl", [command, ...args], { stdio: "ignore" });
  };
  const keyOptions = { newkey: "rsa:2048", nodes: true, sha256: true } as const;
  openssl("req", {
    ...keyOptions,
    x509: true,
    days: "1",
    subj: "/CN=OpenClaw watchOS survivor test CA",
    addext: ["basicConstraints=critical,CA:TRUE", "keyUsage=critical,keyCertSign,cRLSign"],
    keyout: caKey,
    out: caCert,
  });
  openssl("req", { ...keyOptions, subj: "/CN=localhost", keyout: serverKey, out: serverCsr });
  writeFileSync(
    serverExt,
    [
      "basicConstraints=critical,CA:FALSE",
      "subjectAltName=DNS:localhost,IP:127.0.0.1",
      "keyUsage=critical,digitalSignature,keyEncipherment",
      "extendedKeyUsage=serverAuth",
      "",
    ].join("\n"),
  );
  openssl("x509", {
    req: true,
    in: serverCsr,
    CA: caCert,
    CAkey: caKey,
    CAcreateserial: true,
    days: "1",
    sha256: true,
    extfile: serverExt,
    out: serverCert,
  });
  return {
    caCert,
    cert: readFileSync(serverCert),
    key: readFileSync(serverKey),
  };
}

function runAdapter(
  command: string,
  values: Record<string, string | undefined>,
  env = process.env,
) {
  const args = Object.entries(values).flatMap(([key, value]) =>
    value === undefined ? [] : ["--" + key, value],
  );
  return execFileAsync(process.execPath, [adapter, command, ...args], { env });
}

function connect(state: string, out: string, label: string, caCert: string, credential?: string) {
  return runAdapter(
    "connect",
    {
      mode: credential ? "bootstrap" : "device",
      credential,
      state,
      out,
      label,
    },
    { ...process.env, NODE_EXTRA_CA_CERTS: caCert },
  );
}

function assertArtifact(
  file: string,
  secrets: string[],
  expected: Record<string, unknown> = { endpointSource: "persistedState" },
) {
  const raw = readFileSync(file, "utf8");
  for (const secret of secrets) {
    expect(raw).not.toContain(secret);
  }
  expect(JSON.parse(raw)).toMatchObject({
    pollStatus: 200,
    pollAuthenticated: true,
    transport: "https",
    ...expected,
  });
}

async function gateway(
  tls: ReturnType<typeof createTlsFixture>,
  deviceTokens: string[],
  prefix = "session",
) {
  const requests: Array<Record<string, any>> = [];
  const pollTokens: string[] = [];
  let challengeCount = 0;
  const server = createServer({ cert: tls.cert, key: tls.key }, (request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url?.endsWith("/challenge")) {
      response.end(
        JSON.stringify({ ok: true, nonce: `nonce-${++challengeCount}`, ts: Date.now() }),
      );
    } else if (request.url?.endsWith("/connect")) {
      let raw = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => {
        raw += chunk;
      });
      request.on("end", () => {
        const body = JSON.parse(raw);
        requests.push(body);
        response.end(
          JSON.stringify({
            ok: true,
            sessionToken: `${prefix}-${requests.length}`,
            deviceToken: deviceTokens[Math.min(requests.length - 1, deviceTokens.length - 1)],
            nodeId: body.device.id,
            protocol: 4,
          }),
        );
      });
    } else if (request.url?.endsWith("/poll")) {
      pollTokens.push(request.headers.authorization ?? "");
      response.end(JSON.stringify({ ok: true, event: null }));
    } else {
      response.statusCode = 404;
      response.end();
    }
  });
  await new Promise<void>((resolveListen) => {
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("failed to bind watch fixture");
  }
  const close = () =>
    new Promise<void>((resolveClose) => {
      server.close(() => resolveClose());
    });
  return { address, requests, pollTokens, close };
}

function signaturePayload(body: Record<string, any>, token: string): string {
  return [
    "v3",
    body.device.id,
    body.client.id,
    body.client.mode,
    body.role,
    body.scopes.join(","),
    String(body.device.signedAt),
    token,
    body.device.nonce,
    body.client.platform.toLowerCase(),
    body.client.deviceFamily.toLowerCase(),
  ].join("|");
}

describe.skipIf(process.platform === "win32")("watchOS direct-node survivor", () => {
  it("bootstraps, rotates credentials and reconnects with the shipped WatchDirectNode contract", async () => {
    const root = tempDirs.make("watchos-direct-node-");
    const state = join(root, "state.json");
    const setup = join(root, "setup.json");
    const bootstrapArtifact = join(root, "bootstrap.json");
    const reconnectArtifact = join(root, "reconnect.json");
    const rotatedArtifact = join(root, "rotated.json");
    const tls = createTlsFixture(root);
    const bootstrapToken = "bootstrap-secret";
    const deviceToken = "retained-device-secret";
    const rotatedToken = "rotated-device-secret";
    const { address, requests, pollTokens, close } = await gateway(tls, [
      deviceToken,
      rotatedToken,
    ]);
    writeJson(setup, {
      setupCode: `oc-pair://${Buffer.from(
        JSON.stringify({
          url: `wss://localhost:${address.port}`,
          bootstrapToken,
          expiresAtMs: Date.now() + 60_000,
        }),
      ).toString("base64url")}`,
    });

    try {
      await connect(state, bootstrapArtifact, "baseline", tls.caCert, setup);
      await connect(state, reconnectArtifact, "candidate", tls.caCert);
      await connect(state, rotatedArtifact, "restart", tls.caCert);
    } finally {
      await close();
    }

    expect(requests).toHaveLength(3);
    expect(pollTokens).toEqual(["Bearer session-1", "Bearer session-2", "Bearer session-3"]);
    const [bootstrap, reconnect, rotated] = requests;
    if (!bootstrap || !reconnect || !rotated) {
      throw new Error("watch fixture omitted bootstrap, reconnect, or rotated request");
    }
    expect(bootstrap).toMatchObject({
      minProtocol: 4,
      maxProtocol: 4,
      client: {
        id: "openclaw-watchos",
        version: "2026.8.10",
        platform: "watchOS 11.5.0",
        deviceFamily: "Apple Watch",
        mode: "node",
        instanceId: "watchos-upgrade-survivor",
      },
      caps: [],
      commands: ["device.info", "device.status", "system.notify"],
      permissions: { notifications: true },
      role: "node",
      scopes: [],
      auth: { bootstrapToken },
    });
    expect(reconnect).toMatchObject({
      client: { id: "openclaw-watchos", mode: "node", instanceId: "watchos-upgrade-survivor" },
      auth: { deviceToken },
      device: { id: bootstrap.device.id, publicKey: bootstrap.device.publicKey },
    });
    expect(requests.slice(1).map((body) => body.auth.deviceToken)).toEqual([
      deviceToken,
      rotatedToken,
    ]);
    const publicKey = crypto.createPublicKey({
      key: Buffer.concat([
        Buffer.from("302a300506032b6570032100", "hex"),
        Buffer.from(bootstrap.device.publicKey, "base64url"),
      ]),
      format: "der",
      type: "spki",
    });
    for (const [body, token] of [
      [bootstrap, bootstrapToken],
      [reconnect, deviceToken],
      [rotated, rotatedToken],
    ] as const) {
      expect(
        crypto.verify(
          null,
          Buffer.from(signaturePayload(body, token)),
          publicKey,
          Buffer.from(body.device.signature, "base64url"),
        ),
      ).toBe(true);
    }
    expect(JSON.parse(readFileSync(state, "utf8"))).toMatchObject({
      deviceId: bootstrap.device.id,
      instanceId: "watchos-upgrade-survivor",
      deviceToken: rotatedToken,
      endpoint: {
        host: "localhost",
        port: address.port,
        tls: true,
      },
    });
    for (const [index, artifactPath] of [
      bootstrapArtifact,
      reconnectArtifact,
      rotatedArtifact,
    ].entries()) {
      assertArtifact(
        artifactPath,
        [bootstrapToken, deviceToken, rotatedToken, `session-${index + 1}`],
        {
          ok: true,
          challengeStatus: 200,
          connectStatus: 200,
          protocol: 4,
          protocolRange: [4, 4],
          clientId: "openclaw-watchos",
          clientMode: "node",
          instanceId: "watchos-upgrade-survivor",
          endpointSource: index === 0 ? "setupCode" : "persistedState",
        },
      );
    }
  });

  it("asserts online node presence with one paired watch and no pending pairing", async () => {
    const root = tempDirs.make("watchos-direct-node-state-");
    const state = join(root, "state.json");
    const nodes = join(root, "nodes.json");
    const devices = join(root, "devices.json");
    const artifact = join(root, "artifact.json");
    writeJson(state, {
      deviceId: "watch-device",
      instanceId: "watchos-upgrade-survivor",
    });
    writeJson(nodes, {
      nodes: [
        {
          nodeId: "watch-device",
          clientId: "openclaw-watchos",
          clientMode: "node",
        },
      ],
    });
    writeJson(devices, {
      pending: [],
      paired: [{ deviceId: "watch-device" }],
    });

    await runAdapter("assert-state", {
      state,
      nodes,
      devices,
      out: artifact,
      label: "candidate",
    });

    expect(JSON.parse(readFileSync(artifact, "utf8"))).toEqual({
      label: "candidate",
      ok: true,
      onlineNode: true,
      pendingTotal: 0,
      pendingForWatch: 0,
      pairedForWatch: 1,
      clientId: "openclaw-watchos",
      clientMode: "node",
      nodeId: "watch-device",
      instanceId: "watchos-upgrade-survivor",
    });
  });
});
