import fs from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { listDirectoryTreeStrictSync } from "../infra/directory-walk.js";
import * as runtimeProcess from "../infra/runtime-process-url.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { reserveTestPortListener } from "../test-utils/port-claims.js";
import { executeSystemAgentOperation as execute } from "./operations-execute.js";
import { createSystemAgentTestRuntime } from "./system-agent.runtime.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

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

it("reports hosted Doctor findings without initializing or repairing operator state", () =>
  withOpenClawTestState(
    {
      label: "hosted-doctor-readonly",
      layout: "split",
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
      expect(lines.join("\n")).toContain("core/doctor/gateway-config");
      expect(lines.join("\n")).toContain("gateway.mode is unset");
    },
  ));
