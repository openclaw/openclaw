import fs from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  registerSealedRuntimeProcessEntrypoint,
  resolveRuntimeProcessEntrypointUrl,
} from "../infra/runtime-process-url.js";
import { reserveTestPortListener } from "../test-utils/port-claims.js";
import { executeSystemAgentOperation } from "./operations-execute.js";
import { createSystemAgentTestRuntime } from "./system-agent.runtime.test-support.js";

vi.mock("../commands/doctor.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../commands/doctor.js")>()),
  doctorCommand: () => {
    throw new Error("Doctor ran on the host event loop");
  },
}));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

it("keeps the host responsive while a hosted Doctor process performs synchronous work", async () => {
  const root = tempDirs.make("hosted-doctor-process-");
  const fixture = path.join(root, "doctor.mjs");
  let served = false;
  const listener = await reserveTestPortListener({
    offsets: [0],
    createListener: () =>
      createServer((_request, response) => {
        served = true;
        response.end("host responded 🦞");
      }),
  });
  const request = `fetch("http://127.0.0.1:${listener.claim.port}/doctor").then(async response => process.stdout.write(await response.text()));`;
  fs.writeFileSync(
    fixture,
    `import { execFileSync } from "node:child_process";
const response = execFileSync(process.execPath, ["-e", ${JSON.stringify(request)}], { encoding: "utf8" });
process.stdout.write(JSON.stringify({ pid: process.pid, cwd: process.cwd(), response }) + "\\n");
process.stderr.write("doctor diagnostic 🦞\\n");
`,
  );
  const originalWorker = resolveRuntimeProcessEntrypointUrl("doctor");
  registerSealedRuntimeProcessEntrypoint("doctor", pathToFileURL(fixture));
  const { runtime, lines } = createSystemAgentTestRuntime();
  try {
    await expect(executeSystemAgentOperation({ kind: "doctor" }, runtime)).resolves.toEqual({
      applied: false,
    });
    const output = lines.find((line) => line.startsWith("{"));
    expect(output).toBeDefined();
    const report: { pid: number; cwd: string; response: string } = JSON.parse(output!);
    expect(report.pid).not.toBe(process.pid);
    expect(report.cwd).toBe(process.cwd());
    expect(report.response).toBe("host responded 🦞");
    expect(served).toBe(true);
    expect(lines).toContain("doctor diagnostic 🦞");
  } finally {
    registerSealedRuntimeProcessEntrypoint("doctor", originalWorker);
    await listener.releaseListener();
    await listener.claim.release();
  }
});
