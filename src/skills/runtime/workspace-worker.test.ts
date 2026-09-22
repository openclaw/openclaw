import fs from "node:fs/promises";
import path from "node:path";
import { PassThrough, Readable } from "node:stream";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { serveWorkspaceSkills } from "./workspace-worker.js";

const temporary = useAutoCleanupTempDirTracker(afterEach);

it("uses the native dependency recipe validator without any source paths", async () => {
  const f = fixture();
  const output = new PassThrough();
  let result = "";
  output.on("data", (chunk: Buffer) => {
    result += chunk.toString();
  });
  await serveWorkspaceSkills({
    ...f,
    operation: "installDependencies",
    input: Readable.from([
      JSON.stringify({
        skillKey: "test",
        spec: { kind: "node", package: "--not-a-package" },
        preferences: { nodeManager: "npm", preferBrew: false },
        timeoutMs: 1000,
      }),
    ]),
    output,
  });
  expect(JSON.parse(result)).toMatchObject({
    ok: false,
    message: "node package value is empty or starts with a dash",
  });
});

function fixture() {
  const home = temporary.make("skills-worker-");
  return { home, workspace: path.join(home, "workspace") };
}

it("keeps native file replacement behind the Gateway policy decision", async () => {
  const f = fixture();
  const extractedRoot = path.join(f.home, ".cache/openclaw/skill-installs/source");
  await fs.mkdir(extractedRoot, { recursive: true });
  await fs.writeFile(path.join(extractedRoot, "SKILL.md"), "# Test skill\n");
  const input = new PassThrough();
  const output = new PassThrough();
  const messages: unknown[] = [];
  const prepared = new Promise<void>((resolve) => {
    output.once("data", (chunk: Buffer) => {
      messages.push(JSON.parse(chunk.toString()));
      resolve();
    });
  });
  const run = serveWorkspaceSkills({ ...f, operation: "applyRoot", input, output });
  input.write(`${JSON.stringify({ extractedRoot, slug: "test", mode: "install" })}\n`);
  await prepared;
  expect(messages).toEqual([{ type: "prepared", mode: "install" }]);
  await expect(fs.stat(path.join(f.workspace, "skills/test"))).rejects.toMatchObject({
    code: "ENOENT",
  });
  output.on("data", (chunk: Buffer) => messages.push(JSON.parse(chunk.toString())));
  input.end(
    `${JSON.stringify({ decision: { error: "Denied by policy", failureKind: "invalid-request" } })}\n`,
  );
  await run;
  expect(messages[1]).toEqual({
    type: "result",
    result: { ok: false, error: "Denied by policy", failureKind: "invalid-request" },
  });
  await expect(fs.stat(path.join(f.workspace, "skills/test"))).rejects.toMatchObject({
    code: "ENOENT",
  });
});

it("rejects a discovery request for another workspace before scanning it", async () => {
  const f = fixture();
  const input = Readable.from([
    JSON.stringify({ sourcePlan: { workspaceDir: path.join(f.home, "other") } }),
  ]);
  await expect(
    serveWorkspaceSkills({ ...f, operation: "discovery", input, output: new PassThrough() }),
  ).rejects.toThrow("does not match the provisioned workspace");
});

it("does not treat unknown operations as discovery", async () => {
  const f = fixture();
  await expect(
    serveWorkspaceSkills({
      ...f,
      operation: "unknown",
      input: Readable.from(["{}"]),
      output: new PassThrough(),
    }),
  ).rejects.toThrow("Unknown skill worker operation");
});
