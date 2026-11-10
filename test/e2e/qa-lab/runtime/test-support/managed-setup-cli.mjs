import { open, readFile } from "node:fs/promises";
import net from "node:net";
import { basename, dirname } from "node:path";
import { createInterface } from "node:readline";

export async function runManagedSetupCli(socketPath) {
  const argv = process.argv.slice(2);
  const values = (name) => {
    const result = [];
    for (let index = 0; index < argv.length; index++) {
      if (argv[index] === name) {
        result.push(argv[++index]);
      } else if (argv[index].startsWith(name + "=")) {
        result.push(argv[index].slice(name.length + 1));
      }
    }
    return result;
  };
  const allowed = new Set(values("--allow-env"));
  const env = {};
  for (const name of allowed) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      throw new Error("invalid allowed environment name");
    }
    if (process.env[name] !== undefined) {
      env[name] = process.env[name];
    }
  }
  for (const profile of values("--env-from-profile")) {
    for (const line of (await readFile(profile, "utf8")).split("\n")) {
      if (!line.trim()) {
        continue;
      }
      const separator = line.indexOf("=");
      const name = line.slice(0, separator);
      const value = JSON.parse(line.slice(separator + 1));
      if (separator < 1 || !allowed.has(name) || typeof value !== "string") {
        throw new Error("environment profile contains an unauthorized value");
      }
      env[name] = value;
    }
  }
  let script;
  if (argv.includes("--script-stdin")) {
    const chunks = [];
    for await (const chunk of process.stdin) {
      chunks.push(Buffer.from(chunk));
    }
    script = Buffer.concat(chunks).toString("base64");
  }
  let copy;
  if (argv[0] === "cp") {
    // The source belongs to the Gateway namespace, not the host controller.
    const destinationIndex = argv.findIndex((arg) => arg.includes(":/"));
    if (destinationIndex < 2) {
      throw new Error("expected cp LOCAL SANDBOX:REMOTE");
    }
    const destination = argv[destinationIndex];
    const separator = destination.indexOf(":");
    copy = {
      leaseId: destination.slice(0, separator),
      path: destination.slice(separator + 1),
      data: (await readFile(argv[destinationIndex - 1])).toString("base64"),
    };
  }
  const directory = await open(dirname(socketPath), "r");
  try {
    await new Promise((resolve, reject) => {
      const socket = net.createConnection(
        "/proc/self/fd/" + directory.fd + "/" + basename(socketPath),
      );
      let receivedExit = false;
      const cancel = () => {
        if (!socket.destroyed) {
          socket.write(JSON.stringify({ cancel: true }) + "\n");
        }
      };
      process.on("SIGTERM", cancel);
      process.on("SIGINT", cancel);
      socket.on("connect", () => socket.write(JSON.stringify({ argv, env, script, copy }) + "\n"));
      socket.on("error", () => reject(new Error("managed setup backend connection failed")));
      createInterface({ input: socket }).on("line", (line) => {
        const frame = JSON.parse(line);
        if (frame.stdout) {
          process.stdout.write(Buffer.from(frame.stdout, "base64"));
        }
        if (frame.stderr) {
          process.stderr.write(Buffer.from(frame.stderr, "base64"));
        }
        if (typeof frame.exitCode === "number") {
          receivedExit = true;
          process.exitCode = frame.exitCode;
        }
      });
      socket.on("close", () => {
        process.removeListener("SIGTERM", cancel);
        process.removeListener("SIGINT", cancel);
        if (receivedExit) {
          resolve();
        } else {
          reject(new Error("managed setup backend closed without command settlement"));
        }
      });
    });
  } finally {
    await directory.close();
  }
}
