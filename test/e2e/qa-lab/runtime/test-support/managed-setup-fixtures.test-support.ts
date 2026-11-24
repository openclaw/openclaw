import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { createServer } from "node:https";
import { connect } from "node:net";
import path from "node:path";
import { createServer as createTlsServer } from "node:tls";
import { rawDataToString } from "@openclaw/gateway-client/websocket-data";
import { withSqliteReadOnlyInspection } from "openclaw/plugin-sdk/sqlite-runtime";
import { Value } from "typebox/value";
import { WebSocket } from "ws";
import { z } from "zod";
import {
  ResponseFrameSchema,
  type ResponseFrame,
} from "../../../../../packages/gateway-protocol/src/schema/frames.js";
import {
  getNodeSqliteKysely,
  executeSqliteQueryTakeFirstSync,
} from "../../../../../src/infra/kysely-sync.js";
import { runCommandWithTimeout } from "../../../../../src/process/exec.js";
import { createDeferredCore } from "../../../../../src/shared/deferred.js";
import { resolveOpenClawStateSqlitePath } from "../../../../../src/state/openclaw-state-db.paths.js";
import { managedSetupPodmanEnv } from "./managed-setup-podman.mjs";
import {
  SETUP_PROOF_GITHUB_TOKEN as TOKEN,
  SETUP_PROOF_REMOTE,
} from "./setup-repository-integration/api.js";

export async function command(argv: string[], cwd?: string) {
  const result = await runCommandWithTimeout(argv, {
    cwd,
    timeoutMs: 20_000,
    ...(argv[0] === "podman" ? { baseEnv: managedSetupPodmanEnv(process.env) } : {}),
  });
  if (result.code !== 0) {
    throw new Error(`Fixture command ${argv[0]} failed: ${result.stderr}`);
  }
  return result.stdout.trim();
}

export async function githubFixture(root: string, repository: string) {
  const key = path.join(root, "github.key");
  const cert = path.join(root, "github.crt");
  await command([
    "openssl",
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    key,
    "-out",
    cert,
    "-subj",
    "/CN=localhost",
    "-addext",
    "subjectAltName=DNS:localhost,IP:127.0.0.1",
    "-days",
    "1",
  ]);
  const head = await command(["git", "rev-parse", "HEAD"], repository);
  const tree = await command(["git", "rev-parse", "HEAD^{tree}"], repository);
  const metadata = {
    id: 7,
    node_id: "R_setup_fixture",
    name: "setup-proof",
    full_name: "example/setup-proof",
    clone_url: SETUP_PROOF_REMOTE,
    private: false,
    default_branch: "main",
    owner: { login: "example" },
    permissions: { pull: true, push: true, admin: true },
  };
  let verified = 0;
  const server = createServer(
    { key: await fs.readFile(key), cert: await fs.readFile(cert) },
    (incoming, response) => {
      void (async () => {
        if (!incoming.headers.authorization?.endsWith(TOKEN)) {
          response.writeHead(401).end();
          return;
        }
        response.setHeader("Content-Type", "application/json");
        response.setHeader("x-oauth-scopes", "repo");
        const route = new URL(incoming.url ?? "/", "https://api.github.com").pathname;
        let value: unknown;
        if (route === "/user") {
          verified++;
          value = { id: 4243, login: "setup-fixture", type: "User", avatar_url: null };
        } else if (route === "/graphql") {
          value = {
            data: {
              node: {
                ...metadata,
                __typename: "Repository",
                object: { __typename: "Commit", sha: head, tree: { sha: tree } },
              },
            },
          };
        } else if (route === "/repos/example/setup-proof") {
          value = metadata;
        } else if (route.startsWith("/repos/example/setup-proof/commits/")) {
          value = { sha: head, commit: { tree: { sha: tree } } };
        } else if (route === "/repos/example/setup-proof/git/commits/" + head) {
          value = { sha: head, tree: { sha: tree } };
        } else {
          const object = /^\/repos\/example\/setup-proof\/git\/(trees|blobs)\/([a-f0-9]{40})$/.exec(
            route,
          );
          if (!object) {
            response.writeHead(404).end("{}");
            return;
          }
          const sha = object[2]!;
          if (object[1] === "trees") {
            const listing = await command(["git", "ls-tree", "-z", sha], repository);
            value = {
              sha,
              truncated: false,
              tree: listing
                .split("\0")
                .filter(Boolean)
                .map((line) => {
                  const [header, filename] = line.split("\t");
                  const [mode, type, objectSha] = header!.split(" ");
                  return { mode, type, sha: objectSha, path: filename };
                }),
            };
          } else {
            const result = await runCommandWithTimeout(["git", "cat-file", "blob", sha], {
              cwd: repository,
              timeoutMs: 20_000,
            });
            if (result.code !== 0) {
              throw new Error("Fixture Git blob lookup failed");
            }
            value = {
              sha,
              size: Buffer.byteLength(result.stdout),
              encoding: "base64",
              content: Buffer.from(result.stdout).toString("base64"),
            };
          }
        }
        response.end(JSON.stringify(value));
      })().catch(() => response.writeHead(500).end("{}"));
    },
  );
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert(address && typeof address !== "string");
  return {
    apiBaseUrl: `https://127.0.0.1:${address.port}`,
    cert,
    get verified() {
      return verified;
    },
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}

export async function request(
  ws: WebSocket,
  method: string,
  params: unknown,
  signal: AbortSignal,
): Promise<ResponseFrame> {
  const id = randomUUID();
  const pending = createDeferredCore<ResponseFrame>();
  const onMessage = (data: Parameters<typeof rawDataToString>[0]) => {
    const value: unknown = JSON.parse(rawDataToString(data));
    if (Value.Check(ResponseFrameSchema, value) && value.id === id) {
      pending.resolve(value);
    }
  };
  const abort = () => pending.reject(signal.reason);
  const closed = (code: number) => pending.reject(new Error(`Requester closed (${code})`));
  ws.on("close", closed);
  ws.on("message", onMessage);
  signal.addEventListener("abort", abort, { once: true });
  try {
    signal.throwIfAborted();
    ws.send(JSON.stringify({ type: "req", id, method, params }));
    return await pending.promise;
  } finally {
    ws.off("message", onMessage);
    ws.off("close", closed);
    signal.removeEventListener("abort", abort);
  }
}

export const PREPARATION_MARKER = "SETUP_PREPARATION_MARKER.txt";
export const CHECKOUT_MARKER = "SETUP_CHECKOUT_MARKER.txt";
export const SOURCE_MARKER = "SETUP_SOURCE.txt";
export async function effectFixture() {
  const token = randomUUID();
  const effects: Array<"prepare" | "checkout"> = [];
  const server = createHttpServer((req, res) => {
    void (async () => {
      if (req.method !== "POST" || req.url !== "/effect" || req.headers["x-proof-key"] !== token) {
        res.writeHead(404).end();
        return;
      }
      let body = "";
      for await (const chunk of req) {
        body += String(chunk);
        if (body.length > 4096) {
          throw new Error("Oversized effect receipt");
        }
      }
      const { phase } = z
        .object({ phase: z.enum(["prepare", "checkout"]) })
        .parse(JSON.parse(body));
      effects.push(phase);
      res.end("recorded");
    })().catch(() => res.writeHead(400).end());
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert(address && typeof address !== "string");
  const url = "http://10.0.2.2:" + address.port + "/effect";
  const script = [
    'import { writeFile } from "node:fs/promises";',
    "const phase = process.argv[2];",
    'if (phase !== "prepare" && phase !== "checkout") throw new Error("Invalid fixture phase");',
    "const response = await fetch(" +
      JSON.stringify(url) +
      ', { method: "POST", headers: { "content-type": "application/json", "x-proof-key": ' +
      JSON.stringify(token) +
      " }, body: JSON.stringify({phase}) });",
    'if (!response.ok) throw new Error("Effect receipt rejected");',
    'await writeFile(phase === "prepare" ? ' +
      JSON.stringify(PREPARATION_MARKER) +
      " : " +
      JSON.stringify(CHECKOUT_MARKER) +
      ", phase);",
  ].join("\n");
  return {
    effects,
    files: [
      { path: SOURCE_MARKER, content: "actual committed checkout\n" },
      { path: ".nvmrc", content: "system\n" },
      { path: ".openclaw/setup-effect.mjs", content: script },
      {
        path: ".devcontainer/devcontainer.json",
        content: JSON.stringify({
          onCreateCommand: ["node", ".openclaw/setup-effect.mjs", "prepare"],
        }),
      },
      {
        path: ".openclaw/worktree-setup.sh",
        executable: true,
        content: "#!/bin/sh\nset -eu\nexec node .openclaw/setup-effect.mjs checkout\n",
      },
    ],
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}

export async function gitWrapper(root: string, origin: string, caPath?: string) {
  await fs.mkdir(root, { recursive: true });
  const file = path.join(root, "git");
  const contents = [
    "#!/usr/bin/env node",
    'void import("node:child_process").then(({spawnSync})=>{',
    "const args=process.argv.slice(2);",
    'const mapped=args.some(x=>["clone","fetch","ls-remote"].includes(x));',
    'const r=spawnSync("/usr/bin/git",[...(mapped?["-c",' +
      JSON.stringify("url." + origin + ".insteadOf=" + SETUP_PROOF_REMOTE) +
      (caPath ? ',"-c",' + JSON.stringify("http.sslCAInfo=" + caPath) : "") +
      ']:[]),...args],{stdio:"inherit",env:process.env});',
    "if(r.error)throw r.error;process.exitCode=r.status??1;",
    "});",
    "",
  ].join("\n");
  await fs.writeFile(file, contents, { mode: 0o755 });
  return file;
}

// The canonical read-only snapshot preserves the real Gateway record; no state injection.
export async function preparationFacts(
  env: NodeJS.ProcessEnv,
  environmentId: string,
): Promise<unknown> {
  return await withSqliteReadOnlyInspection(resolveOpenClawStateSqlitePath(env), (database) => {
    const query = getNodeSqliteKysely<{
      worker_environments: { environment_id: string; profile_snapshot_json: string };
    }>(database)
      .selectFrom("worker_environments")
      .select("profile_snapshot_json")
      .where("environment_id", "=", environmentId);
    const row = executeSqliteQueryTakeFirstSync(database, query);
    assert(row, "actual environment record missing");
    const facts: unknown = JSON.parse(row.profile_snapshot_json);
    return facts;
  });
}

export async function gatewayTlsFixture(root: string) {
  const key = path.join(root, "gateway-proxy.key");
  const cert = path.join(root, "gateway-proxy.crt");
  await command([
    "openssl",
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    key,
    "-out",
    cert,
    "-subj",
    "/CN=setup-gateway",
    "-addext",
    "subjectAltName=IP:10.0.2.2,DNS:github.com",
    "-days",
    "1",
  ]);
  let targetPort: number | undefined;
  const sockets = new Set<import("node:net").Socket>();
  const servers: ReturnType<typeof createTlsServer>[] = [];
  const credentials = { key: await fs.readFile(key), cert: await fs.readFile(cert) };
  const proxy = async (getPort: () => number | undefined) => {
    const server = createTlsServer(credentials, (socket) => {
      const port = getPort();
      if (!port) {
        socket.destroy();
        return;
      }
      sockets.add(socket);
      const upstream = connect(port, "127.0.0.1");
      sockets.add(upstream);
      socket.on("error", () => upstream.destroy());
      upstream.on("error", () => socket.destroy());
      socket.on("close", () => {
        sockets.delete(socket);
        upstream.destroy();
      });
      upstream.on("close", () => {
        sockets.delete(upstream);
        socket.destroy();
      });
      socket.pipe(upstream).pipe(socket);
    });
    servers.push(server);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    assert(address && typeof address !== "string");
    return "https://10.0.2.2:" + address.port;
  };
  const origin = await proxy(() => targetPort);
  return {
    cert,
    key,
    origin,
    bindGateway(port: number | undefined) {
      assert(port);
      targetPort = port;
      return origin;
    },
    proxyTo: (port: number) => proxy(() => port),
    async close() {
      for (const socket of sockets) {
        socket.destroy();
      }
      await Promise.all(
        servers.map(
          (server) =>
            new Promise<void>((resolve) => {
              server.close(() => resolve());
            }),
        ),
      );
    },
  };
}
