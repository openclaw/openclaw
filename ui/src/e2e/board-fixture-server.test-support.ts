import { spawn, type ChildProcessByStdio } from "node:child_process";
import { once } from "node:events";
import { type AddressInfo, createServer } from "node:net";
import path from "node:path";
import type { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterAll } from "vitest";
import { stopChildProcess } from "../../../test/helpers/stop-child-process.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

type FixtureProcess = ChildProcessByStdio<null, Readable, Readable>;
const fixtureProcesses = new Set<FixtureProcess>();

afterAll(async () => {
  await Promise.all([...fixtureProcesses].map((child) => stopChildProcess(child, 5_000)));
});

export type FixtureServer = {
  child: FixtureProcess;
  url: string;
};

async function reservePort(): Promise<number> {
  const server = createServer();
  const listening = once(server, "listening");
  server.listen(0, "127.0.0.1");
  await listening;
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return port;
}

export async function startFixtureServer(
  fixture?: "attachments" | "workboard",
): Promise<FixtureServer> {
  const port = await reservePort();
  const url = `http://127.0.0.1:${port}/__fixtures/board/`;
  const child = spawn(
    process.execPath,
    [
      "--import",
      "./scripts/tsx.mjs",
      "scripts/control-ui-mock-dev.ts",
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      ...(fixture ? ["--fixture", fixture] : []),
    ],
    {
      cwd: repoRoot,
      env: { ...process.env, CI: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  // Retain startup children too, so a hook timeout still reaches their cleanup.
  fixtureProcesses.add(child);
  child.once("close", () => fixtureProcesses.delete(child));
  let output = "";
  for (const stream of [child.stdout, child.stderr]) {
    stream.setEncoding("utf8");
    stream.on("data", (chunk: string) => {
      output += chunk;
    });
  }
  const mockServer = { child, url };

  try {
    // The CLI publishes this only after listen; cold imports are not readiness failures.
    await new Promise<void>((resolve, reject) => {
      const settle = (error?: Error) => {
        child.stdout.off("data", onOutput);
        child.off("close", onClose);
        child.off("error", settle);
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      };
      const onOutput = () => {
        if (output.includes(`[control-ui-mock] board fixture: ${url}`)) {
          settle();
        }
      };
      const onClose = () =>
        settle(new Error(`Control UI mock server exited before startup\n${output}`));
      child.stdout.on("data", onOutput);
      child.once("close", onClose);
      child.once("error", settle);
    });
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Control UI mock server returned ${response.status}\n${output}`);
    }
    return mockServer;
  } catch (error) {
    await stopFixtureServer(mockServer);
    throw error;
  }
}

export async function stopFixtureServer(server: FixtureServer | undefined): Promise<void> {
  if (server) {
    await stopChildProcess(server.child, 5_000);
  }
}
