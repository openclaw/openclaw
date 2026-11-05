import { spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import net from "node:net";
import { constants } from "node:os";
import { dirname } from "node:path";
import { createInterface } from "node:readline";

const socketPath = "/run/openclaw-managed-setup.sock";
const cleanEnvironment = {
  PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
  HOME: "/home/worker",
  USER: "root",
  LOGNAME: "root",
  LANG: "C.UTF-8",
  ...(process.env.NODE_EXTRA_CA_CERTS
    ? { NODE_EXTRA_CA_CERTS: process.env.NODE_EXTRA_CA_CERTS }
    : {}),
};

if (process.argv[2] === "client") {
  const socket = net.createConnection(socketPath);
  socket.on("error", () => {
    process.stderr.write("managed setup guest transport failed\n");
    process.exitCode = 1;
    process.stdin.destroy();
  });
  socket.on("connect", () => process.stdin.pipe(socket));
  socket.pipe(process.stdout);
  socket.on("close", () => process.stdin.destroy());
} else if (process.argv[2] === "server") {
  const gitHttps = await readFile("/managed-setup-git-https.json", "utf8")
    .then(JSON.parse)
    .catch((error) => {
      if (error.code === "ENOENT") {
        return undefined;
      }
      throw error;
    });
  if (gitHttps) {
    // The managed CLI prepends its verified Git binary to PATH. Serve the external
    // repository at its real HTTPS authority instead of replacing that binary.
    const proxy = createHttpsServer(
      { key: gitHttps.key, cert: gitHttps.cert },
      (request, response) => {
        const url = new URL(request.url ?? "/", "https://github.com");
        if (
          url.pathname !== gitHttps.repositoryPath &&
          !url.pathname.startsWith(gitHttps.repositoryPath + "/")
        ) {
          response.writeHead(404).end();
          return;
        }
        const upstream = httpRequest(
          {
            hostname: "10.0.2.2",
            port: gitHttps.port,
            method: request.method,
            path: "/repo.git" + url.pathname.slice(gitHttps.repositoryPath.length) + url.search,
            headers: { ...request.headers, host: "localhost" },
          },
          (incoming) => {
            response.writeHead(incoming.statusCode ?? 502, incoming.headers);
            incoming.pipe(response);
          },
        );
        upstream.on("error", () => {
          if (!response.headersSent) {
            response.writeHead(502);
          }
          response.end();
        });
        request.on("error", () => upstream.destroy());
        response.on("close", () => upstream.destroy());
        request.pipe(upstream);
      },
    );
    await new Promise((resolve, reject) => {
      proxy.once("error", reject);
      proxy.listen(443, "127.0.0.1", resolve);
    });
  }
  process.umask(0o077);
  await mkdir("/home/worker", { recursive: true });
  await mkdir("/workspace", { recursive: true });
  await mkdir("/run", { recursive: true });
  // A committed filesystem may contain the old controller socket, never its process.
  await rm(socketPath, { force: true });
  const server = net.createServer((socket) => {
    let child;
    let started = false;
    let cancelled = false;
    const send = (frame) => {
      if (!socket.destroyed) {
        socket.write(JSON.stringify(frame) + "\n");
      }
    };
    const killGroup = (signal) => {
      if (!child?.pid) {
        return;
      }
      try {
        process.kill(-child.pid, signal);
      } catch (error) {
        if (error.code !== "ESRCH") {
          throw error;
        }
      }
    };
    const cancel = () => {
      if (!child || cancelled) {
        return;
      }
      cancelled = true;
      killGroup("SIGTERM");
      // Settle the group even if its shell exits before its descendants.
      setTimeout(() => killGroup("SIGKILL"), 500);
    };
    socket.on("error", cancel);
    socket.on("close", cancel);
    createInterface({ input: socket }).on("line", async (line) => {
      try {
        const request = JSON.parse(line);
        if (request.cancel) {
          cancel();
          return;
        }
        if (started) {
          throw new Error("one guest request per connection");
        }
        started = true;
        if (request.operation === "ping") {
          send({ exitCode: 0 });
          socket.end();
          return;
        }
        if (request.operation === "read") {
          try {
            send({ data: (await readFile(request.path)).toString("base64") });
          } catch (error) {
            if (error.code !== "ENOENT") {
              throw error;
            }
            send({ missing: true });
          }
          send({ exitCode: 0 });
          socket.end();
          return;
        }
        if (request.operation === "write") {
          await mkdir(dirname(request.path), { recursive: true });
          await writeFile(request.path, Buffer.from(request.data, "base64"));
          send({ exitCode: 0 });
          socket.end();
          return;
        }
        if (request.operation !== "run") {
          throw new Error("unknown guest operation");
        }
        child = spawn("/bin/sh", ["-se"], {
          cwd: "/workspace",
          env: { ...cleanEnvironment, ...request.env },
          detached: true,
          stdio: ["pipe", "pipe", "pipe"],
        });
        child.stdout.on("data", (data) => send({ stdout: data.toString("base64") }));
        child.stderr.on("data", (data) => send({ stderr: data.toString("base64") }));
        child.stdin.on("error", () => {});
        child.on("error", () => {
          send({ stderr: Buffer.from("guest shell could not start\n").toString("base64") });
        });
        child.on("close", async (code, signal) => {
          if (cancelled) {
            await new Promise((resolve) => {
              setTimeout(resolve, 550);
            });
          }
          // Detached production nodes have their own group and are not killed.
          child = undefined;
          send({ exitCode: code ?? (signal ? 128 + (constants.signals[signal] ?? 9) : 1) });
          socket.end();
        });
        child.stdin.end(Buffer.from(request.script, "base64"));
      } catch {
        send({ stderr: Buffer.from("invalid managed setup guest request\n").toString("base64") });
        send({ exitCode: 1 });
        socket.end();
      }
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
} else {
  throw new Error("expected managed setup guest server or client");
}
