import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import { createConnection } from "node:net";
import path from "node:path";
import { createInterface } from "node:readline";
import { decodeXml } from "../shared/xml.js";
import { prepareLaunchdUpdateHandoff } from "./update-managed-service-handoff-launchd.js";

export function fixtureProgramArguments(xml: string) {
  const array = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(xml)?.[1] ?? "";
  return [...array.matchAll(/<string>([\s\S]*?)<\/string>/g)].map((m) => decodeXml(m[1]!));
}

// Linux-only inetd adapter: launch the exact Node program from the generated plist
// with a listening fd on stdin. This tests the wire, not native job membership.
export async function probeFixtureSocketJob(directory: string, executable: string) {
  const job = await prepareLaunchdUpdateHandoff({
    directory,
    executable,
    env: {},
    args: ["-e", "process.stdin.once('data', b => process.stdout.write(b))"],
  });
  const xml = await fs.readFile(path.join(directory, "handoff.plist"), "utf8");
  if (!xml.includes("<key>Wait</key><true/>")) {
    throw new Error("fixture requires a listening descriptor");
  }
  const argv = fixtureProgramArguments(xml).slice(5);
  const socketPath = job.args[1]!;
  const proxy = spawn(
    "python3",
    [
      "-c",
      `import os, socket, sys
s = socket.socket(socket.AF_UNIX); s.bind(sys.argv[1]); s.listen(1)
os.dup2(s.fileno(), 0); print('listening', flush=True); os.execv(sys.argv[2], sys.argv[2:])`,
      socketPath,
      ...argv,
    ],
    { cwd: directory, stdio: ["ignore", "pipe", "inherit"] },
  );
  try {
    const bootstrap = createInterface({ input: proxy.stdout })[Symbol.asyncIterator]();
    if ((await bootstrap.next()).value !== "listening") {
      throw new Error("fixture socket unavailable");
    }
    const client = createConnection(socketPath);
    try {
      client.setTimeout(5000, () => client.destroy(new Error("fixture socket timeout")));
      const lines = createInterface({ input: client })[Symbol.asyncIterator]();
      client.write("socket-probe\n");
      return (await lines.next()).value;
    } finally {
      client.destroy();
    }
  } finally {
    proxy.kill();
  }
}
