import { createHash } from "node:crypto";
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
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
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

it("reports hosted Doctor findings without initializing or repairing operator state", async () => {
  await withOpenClawTestState(
    {
      label: "hosted-doctor-readonly",
      layout: "split",
      scenario: "external-service",
      // Compiled test workers can still resolve the checkout's source Plugin SDK.
      env: {
        NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import=${pathToFileURL(path.resolve("scripts/tsx.mjs")).href}`,
      },
    },
    async (state) => {
      await state.writeConfig({
        agents: { entries: {} },
        plugins: { enabled: false },
        memory: { search: { enabled: false } },
      });
      const snapshot = () => {
        const directories = [""];
        const entries = [];
        for (const directory of directories) {
          for (const name of fs.readdirSync(path.join(state.root, directory))) {
            const relative = path.join(directory, name);
            const filename = path.join(state.root, relative);
            const stat = fs.lstatSync(filename, { bigint: true });
            entries.push({
              path: relative,
              mode: stat.mode,
              symlinkTarget: stat.isSymbolicLink() ? fs.readlinkSync(filename) : undefined,
              sha256: stat.isFile()
                ? createHash("sha256").update(fs.readFileSync(filename)).digest("hex")
                : undefined,
              mtimeNs: stat.isFile() ? stat.mtimeNs : undefined,
            });
            // Capture links can point outside the fixture, including back to this checkout.
            if (stat.isDirectory()) {
              directories.push(relative);
            }
          }
        }
        return entries.toSorted((left, right) => left.path.localeCompare(right.path));
      };
      const before = snapshot();
      const { runtime, lines } = createSystemAgentTestRuntime();
      // Findings are expected (gateway.mode is unset); nonzero lint is not a repair.
      await expect(executeSystemAgentOperation({ kind: "doctor" }, runtime)).rejects.toThrow(
        "exit 1",
      );
      expect(snapshot()).toEqual(before);
      expect(lines.join("\n")).toContain("core/doctor/gateway-config");
      expect(lines.join("\n")).toContain("gateway.mode is unset");
    },
  );
});
