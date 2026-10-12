import "../../test-utils/prepare-compiled-subprocesses.js";
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

it.each([false, true])(
  "supports the SSH publisher's single policy reply (allowed=%s)",
  async (allowed) => {
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
      `${JSON.stringify({ decision: allowed ? null : { error: "Denied by policy", failureKind: "invalid-request" } })}\n`,
    );
    await run;
    expect(messages).toHaveLength(2);
    if (allowed) {
      expect(messages[1]).toMatchObject({ type: "result", result: { ok: true, mode: "install" } });
      expect(await fs.readFile(path.join(f.workspace, "skills/test/SKILL.md"), "utf8")).toBe(
        "# Test skill\n",
      );
      return;
    }
    expect(messages[1]).toEqual({
      type: "result",
      result: { ok: false, error: "Denied by policy", failureKind: "invalid-request" },
    });
    await expect(fs.stat(path.join(f.workspace, "skills/test"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  },
);

it.each([
  { operation: "discovery", error: "does not match the provisioned workspace" },
  { operation: "unknown", error: "Unknown skill worker operation" },
])(
  "rejects $operation before scanning an unprovisioned workspace",
  async ({ operation, error }) => {
    const f = fixture();
    await expect(
      serveWorkspaceSkills({
        ...f,
        operation,
        input: Readable.from([
          JSON.stringify(
            operation === "discovery"
              ? { sourcePlan: { workspaceDir: path.join(f.home, "other") } }
              : {},
          ),
        ]),
        output: new PassThrough(),
      }),
    ).rejects.toThrow(error);
  },
);
