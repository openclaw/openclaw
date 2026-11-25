import fs from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { listDirectoryTreeStrictSync } from "../infra/directory-walk.js";
import * as runtimeProcess from "../infra/runtime-process-url.js";
import { withCommandProcessScope } from "../process/exec-spawn.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { reserveTestPortListener } from "../test-utils/port-claims.js";
import { executeSystemAgentOperation as execute } from "./operations-execute.js";
import { createSystemAgentTestRuntime } from "./system-agent.runtime.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it.each([false, true])(
  "reaps cancelled hosted Doctor work (ignores SIGTERM: %s)",
  async (ignore) => {
    const fixture = path.join(tempDirs.make("hosted-doctor-cancel-"), "doctor.mjs");
    const receipt = `${fixture}.signal`;
    fs.writeFileSync(
      fixture,
      `import { writeFileSync } from "node:fs";
process.on("SIGTERM", () => {
  writeFileSync(${JSON.stringify(receipt)}, "SIGTERM");
  ${ignore ? "" : "process.exit(143);"}
});
setInterval(() => {}, 1000);
process.stdout.write("ready:" + process.pid + "\\n");
`,
    );
    const resolve = runtimeProcess.resolveRuntimeProcessEntrypointUrl;
    const doctor = vi
      .spyOn(runtimeProcess, "resolveRuntimeProcessEntrypointUrl")
      .mockImplementation((name) => (name === "doctor" ? pathToFileURL(fixture) : resolve(name)));
    const { runtime } = createSystemAgentTestRuntime();
    let pid: number | undefined;
    const log = runtime.log;
    try {
      await expect(
        withCommandProcessScope(async (stop) => {
          runtime.log = (line) => {
            log(line);
            if (typeof line === "string" && line.startsWith("ready:")) {
              pid = Number(line.slice(6));
              stop();
            }
          };
          await execute({ kind: "doctor" }, runtime);
        }),
      ).rejects.toThrow(/aborted/i);
      expect(fs.readFileSync(receipt, "utf8")).toBe("SIGTERM");
      expect(pid).toBeGreaterThan(0);
      expect(() => process.kill(pid!, 0)).toThrow();
    } finally {
      doctor.mockRestore();
      if (pid) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // Already reaped by the operation owner.
        }
      }
    }
  },
);

it("keeps the host responsive while a hosted Doctor process performs synchronous work", async () => {
  const fixture = path.join(tempDirs.make("hosted-doctor-process-"), "doctor.mjs");
  const listener = await reserveTestPortListener({
    offsets: [0],
    createListener: () => createServer((_request, response) => response.end("host responded 🦞")),
  });
  const request = `fetch("http://127.0.0.1:${listener.claim.port}/doctor").then(async response => process.stdout.write(await response.text()));`;
  fs.writeFileSync(
    fixture,
    `import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
assert.notEqual(process.pid, ${process.pid});
assert.equal(process.cwd(), ${JSON.stringify(process.cwd())});
process.stdout.write(execFileSync(process.execPath, ["-e", ${JSON.stringify(request)}]));
process.stderr.write("doctor diagnostic 🦞\\n");
`,
  );
  const resolve = runtimeProcess.resolveRuntimeProcessEntrypointUrl;
  const doctor = vi
    .spyOn(runtimeProcess, "resolveRuntimeProcessEntrypointUrl")
    .mockImplementation((name) => (name === "doctor" ? pathToFileURL(fixture) : resolve(name)));
  const { runtime, lines } = createSystemAgentTestRuntime();
  try {
    await expect(execute({ kind: "doctor" }, runtime)).resolves.toEqual({ applied: false });
    expect(lines).toContain("host responded 🦞");
    expect(lines).toContain("doctor diagnostic 🦞");
  } finally {
    doctor.mockRestore();
    await listener.releaseListener();
    await listener.claim.release();
  }
});

it.each([
  { gateway: {}, finding: "gateway.mode is unset" },
  { gateway: { port: "abc" }, finding: "gateway.port" },
])(
  "reports $finding without opening or repairing an unreadable state database",
  ({ gateway, finding }) =>
    withOpenClawTestState(
      {
        label: "hosted-doctor-readonly",
        layout: "split",
        // Compiled test workers can still resolve the checkout's source Plugin SDK.
        env: {
          OPENCLAW_TEST_RUNTIME_LOG: "1",
          OPENCLAW_TEST_CONSOLE: "1",
          NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import=${pathToFileURL(path.resolve("scripts/tsx.mjs")).href}`,
        },
      },
      async (state) => {
        await state.writeConfig({
          gateway,
          agents: { entries: {} },
          plugins: { enabled: false },
          memory: { search: { enabled: false } },
        });
        const database = state.statePath("state", "openclaw.sqlite");
        fs.mkdirSync(path.dirname(database), { recursive: true });
        fs.writeFileSync(database, "unreadable SQLite state");
        const snapshot = () =>
          listDirectoryTreeStrictSync(state.root).map(({ relativePath: relative }) => {
            const filename = path.join(state.root, relative);
            const stat = fs.lstatSync(filename, { bigint: true });
            return {
              path: relative,
              mode: stat.mode,
              symlinkTarget: stat.isSymbolicLink() ? fs.readlinkSync(filename) : undefined,
              content: stat.isFile() ? fs.readFileSync(filename) : undefined,
              mtimeNs: stat.isFile() ? stat.mtimeNs : undefined,
            };
          });
        const before = snapshot();
        const { runtime, lines } = createSystemAgentTestRuntime();
        await expect(execute({ kind: "doctor" }, runtime)).rejects.toThrow("exit 1");
        expect(snapshot()).toEqual(before);
        expect(lines.join("\n")).toContain(finding);
        expect(lines.join("\n")).toContain("inspections were deferred");
      },
    ),
);
