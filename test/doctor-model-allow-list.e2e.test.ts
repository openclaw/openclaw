import { execFileSync } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { connect } from "node:net";
import path from "node:path";
import type { Duplex } from "node:stream";
import { stripVTControlCharacters } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { resolveSystemBin } from "../src/infra/resolve-system-bin.js";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "./helpers/openclaw-test-instance.js";

let instance: OpenClawTestInstance | undefined;
let catalogProxy: Awaited<ReturnType<typeof createDoctorCatalogProxy>> | undefined;

afterEach(async () => {
  try {
    await instance?.cleanup();
  } finally {
    instance = undefined;
    await catalogProxy?.close();
    catalogProxy = undefined;
  }
});

async function createDoctorCatalogProxy(directory: string, status: number) {
  const openssl = resolveSystemBin("openssl");
  if (!openssl) {
    throw new Error("openssl is required for the Doctor catalog CLI regression");
  }
  const keyPath = path.join(directory, "catalog-key.pem");
  const certPath = path.join(directory, "catalog-cert.pem");
  execFileSync(
    openssl,
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      keyPath,
      "-out",
      certPath,
      "-days",
      "1",
      "-subj",
      "/CN=api.mistral.ai",
      "-addext",
      "subjectAltName=DNS:api.mistral.ai",
    ],
    { stdio: "ignore" },
  );
  const requests: Array<{ method: string | undefined; url: string | undefined }> = [];
  const server = createHttpsServer(
    { key: await fs.readFile(keyPath), cert: await fs.readFile(certPath) },
    (request, response) => {
      requests.push({ method: request.method, url: request.url });
      if (
        request.method !== "GET" ||
        request.url !== "/v1/models" ||
        request.headers.authorization !== "Bearer FAKE_DOCTOR_CATALOG_CREDENTIAL"
      ) {
        response.writeHead(400);
        response.end("Unexpected request");
        return;
      }
      response.writeHead(status, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          data: [
            { id: "codestral-latest", object: "model" },
            { id: "mistral-large-latest", object: "model" },
            { id: "devstral-medium-latest", object: "model" },
          ],
        }),
      );
    },
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Doctor catalog TLS fixture did not bind a TCP port");
  }
  const sockets = new Set<Duplex>();
  const proxy = createServer((_request, response) => {
    response.writeHead(400);
    response.end("CONNECT required");
  });
  proxy.on("connect", (request, client, head) => {
    if (request.url !== "api.mistral.ai:443") {
      client.end("HTTP/1.1 403 Forbidden\r\n\r\n");
      return;
    }
    const upstream = connect(address.port, "127.0.0.1");
    for (const socket of [client, upstream]) {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
    }
    upstream.once("connect", () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) {
        upstream.write(head);
      }
      client.pipe(upstream);
      upstream.pipe(client);
    });
    upstream.once("error", () => client.destroy());
    client.once("error", () => upstream.destroy());
  });
  proxy.listen(0, "127.0.0.1");
  await once(proxy, "listening");
  const proxyAddress = proxy.address();
  if (!proxyAddress || typeof proxyAddress === "string") {
    throw new Error("Doctor catalog proxy did not bind a TCP port");
  }
  return {
    requests,
    env: {
      OPENCLAW_PROXY_ACTIVE: "1",
      HTTPS_PROXY: `http://127.0.0.1:${proxyAddress.port}`,
      NO_PROXY: "127.0.0.1,localhost",
      NODE_EXTRA_CA_CERTS: certPath,
    },
    async close() {
      for (const socket of sockets) {
        socket.destroy();
      }
      for (const listener of [proxy, server]) {
        listener.closeAllConnections();
        await new Promise<void>((resolve, reject) => {
          listener.close((error) => (error ? reject(error) : resolve()));
        });
      }
    },
  };
}

describe("openclaw doctor allow-list consent through the CLI", () => {
  it.each([
    {
      name: "does not offer a change for deprecated-only exclusions",
      allow: ["mistral/codestral-latest", "mistral/mistral-large-latest"],
      status: 200,
      offer: false,
      deferred: false,
    },
    {
      name: "offers a change for an active sibling excluded by the allow list",
      allow: ["mistral/codestral-latest"],
      status: 200,
      offer: true,
      deferred: false,
    },
    {
      name: "defers inspection when provider discovery fails",
      allow: ["mistral/codestral-latest"],
      status: 503,
      offer: false,
      deferred: true,
    },
  ])("$name", async ({ allow, status, offer, deferred }) => {
    instance = await createOpenClawTestInstance({
      name: "doctor-allow-list-discovery",
      env: { MISTRAL_API_KEY: "FAKE_DOCTOR_CATALOG_CREDENTIAL" },
      config: {
        meta: { migrations: { modelPolicyAllowlist: true } },
        cron: { enabled: false },
        agents: {
          ownership: "explicit",
          defaults: {
            model: "mistral/codestral-latest",
            modelPolicy: { allow },
          },
          entries: { main: {} },
        },
        models: {
          mode: "merge",
          catalogRefresh: { enabled: false },
          providers: {
            mistral: {
              baseUrl: "https://api.mistral.ai/v1",
              api: "openai-completions",
              apiKey: "FAKE_DOCTOR_CATALOG_CREDENTIAL",
              agentRuntime: { id: "openclaw" },
            },
          },
        },
        plugins: { allow: ["mistral"], entries: { mistral: { enabled: true } } },
      },
    });
    // Keep the declared provider URL so its deprecated manifest metadata remains authoritative.
    catalogProxy = await createDoctorCatalogProxy(instance.stateDir, status);
    Object.assign(instance.env, catalogProxy.env);
    const before = await fs.readFile(instance.configPath, "utf8");

    const result = await instance.cli(["doctor", "--non-interactive"]);
    const doctorText = stripVTControlCharacters(result.stdout)
      .replaceAll("│", " ")
      .replace(/\s+/gu, " ");

    expect(result.code, result.stderr).toBe(0);
    expect(catalogProxy.requests).toContainEqual({ method: "GET", url: "/v1/models" });
    expect(doctorText).not.toContain("is absent from the model catalog");
    expect(doctorText.includes("Model allow-list offer"), result.stdout).toBe(offer);
    expect(doctorText.includes("Model allow-list inspection is deferred"), result.stdout).toBe(
      deferred,
    );
    expect(await fs.readFile(instance.configPath, "utf8")).toBe(before);
  });

  it("defers legacy-credential preview and repairs credentials before offering the allow-list change", async () => {
    instance = await createOpenClawTestInstance({
      name: "doctor-allow-list-legacy-credentials",
      config: {
        meta: { migrations: { modelPolicyAllowlist: true } },
        cron: { enabled: false },
        agents: {
          ownership: "explicit",
          defaults: {
            model: "openai/fixture-primary",
            modelPolicy: { allow: ["openai/fixture-primary"] },
          },
          entries: { main: {} },
        },
        models: {
          mode: "replace",
          catalogRefresh: { enabled: false },
          providers: {
            openai: {
              api: "openai-completions",
              apiKey: "FAKE_ALLOW_LIST_CREDENTIAL",
              baseUrl: "http://127.0.0.1:9/v1",
              agentRuntime: { id: "openclaw" },
              models: [
                { id: "fixture-primary", name: "Primary", contextWindow: 128000 },
                { id: "fixture-other", name: "Other", contextWindow: 128000 },
              ],
            },
          },
        },
        plugins: { allow: ["openai"], entries: { openai: { enabled: true } } },
      },
    });
    const legacyAuthPath = path.join(
      instance.stateDir,
      "agents",
      "main",
      "agent",
      "auth-profiles.json",
    );
    await fs.mkdir(path.dirname(legacyAuthPath), { recursive: true });
    const legacyAuth = `${JSON.stringify({
      version: 1,
      profiles: {
        "openai:default": {
          type: "api_key",
          provider: "openai",
          key: "FAKE_LEGACY_ALLOW_LIST_CREDENTIAL",
        },
      },
    })}\n`;
    await fs.writeFile(legacyAuthPath, legacyAuth);
    const before = await fs.readFile(instance.configPath, "utf8");

    const preview = await instance.cli(["doctor", "--non-interactive"]);

    expect(preview.code, preview.stderr).toBe(0);
    expect(preview.stdout).toContain("Model allow-list inspection is deferred");
    expect(preview.stdout).not.toContain("Model allow-list offer");
    expect(await fs.readFile(instance.configPath, "utf8")).toBe(before);
    expect(await fs.readFile(legacyAuthPath, "utf8")).toBe(legacyAuth);

    const repaired = await instance.cli(["doctor", "--non-interactive", "--fix"]);

    expect(repaired.code, repaired.stderr).toBe(0);
    expect(repaired.stdout).toContain("Model allow-list offer");
    expect(repaired.stdout).toContain("openai/*");
    expect(repaired.stdout).not.toContain("Model allow-list inspection is deferred");
    expect(JSON.parse(await fs.readFile(instance.configPath, "utf8"))).toMatchObject({
      agents: { defaults: { modelPolicy: { allow: ["openai/fixture-primary"] } } },
    });
  });

  it.each([{ flags: [] }, { flags: ["--fix"] }, { flags: ["--yes"] }])(
    "offers a marked restriction without accepting it with $flags",
    async ({ flags }) => {
      instance = await createOpenClawTestInstance({
        name: "doctor-allow-list-consent",
        config: {
          meta: { migrations: { modelPolicyAllowlist: true } },
          cron: { enabled: false },
          agents: {
            ownership: "explicit",
            defaults: {
              model: "openai/fixture-primary",
              modelPolicy: { allow: ["openai/fixture-primary"] },
            },
            entries: { main: {} },
          },
          models: {
            mode: "replace",
            catalogRefresh: { enabled: false },
            providers: {
              openai: {
                api: "openai-completions",
                apiKey: "FAKE_ALLOW_LIST_CREDENTIAL",
                baseUrl: "http://127.0.0.1:9/v1",
                agentRuntime: { id: "openclaw" },
                models: [
                  { id: "fixture-primary", name: "Primary", contextWindow: 128000 },
                  { id: "fixture-other", name: "Other", contextWindow: 128000 },
                ],
              },
            },
          },
          plugins: { allow: ["openai"], entries: { openai: { enabled: true } } },
        },
      });
      await instance.startGateway();
      await instance.stopGateway();
      const before = await fs.readFile(instance.configPath, "utf8");

      const result = await instance.cli(["doctor", "--non-interactive", ...flags]);

      expect(result.code, result.stderr).toBe(0);
      expect(result.stdout).toContain("Model allow-list offer");
      expect(result.stdout).toContain("openai/*");
      const after = await fs.readFile(instance.configPath, "utf8");
      expect(JSON.parse(after)).toMatchObject({
        agents: { defaults: { modelPolicy: { allow: ["openai/fixture-primary"] } } },
      });
      if (flags.length === 0) {
        expect(after).toBe(before);
      }
    },
  );
});
