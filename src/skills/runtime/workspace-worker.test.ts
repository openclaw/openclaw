import "../../test-utils/prepare-compiled-subprocesses.js";
import fs from "node:fs/promises";
import path from "node:path";
import { PassThrough, Readable } from "node:stream";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { serveWorkspaceSkills } from "./workspace-worker.js";

const temporary = useAutoCleanupTempDirTracker(afterEach);
const denial = { error: "Denied by policy", failureKind: "invalid-request" };
const skill = "# Test skill\n";
const missing = async (target: string) =>
  expect(fs.stat(target)).rejects.toMatchObject({ code: "ENOENT" });

it("validates dependency recipes without source paths", async () => {
  const { invoke, messages } = fixture();
  await invoke("installDependencies", {
    skillKey: "test",
    spec: { kind: "node", package: "--not-a-package" },
    preferences: { nodeManager: "npm", preferBrew: false },
    timeoutMs: 1000,
  });
  const expected = { ok: false, message: "node package value is empty or starts with a dash" };
  expect(messages).toMatchObject([expected]);
});

function fixture() {
  const home = temporary.make("skills-worker-");
  const workspace = path.join(home, "workspace");
  const output = new PassThrough();
  const messages: unknown[] = [];
  output.on("data", (chunk: Buffer) => messages.push(JSON.parse(chunk.toString())));
  const run = (operation: string, input: Readable) =>
    serveWorkspaceSkills({ home, workspace, operation, input, output });
  const invoke = (operation: string, request: unknown) =>
    run(operation, Readable.from([JSON.stringify(request)]));
  return { home, workspace, output, messages, run, invoke };
}

it.each([false, true])("handles one SSH policy reply (allowed=%s)", async (allowed) => {
  const f = fixture();
  const extractedRoot = path.join(f.home, ".cache/openclaw/skill-installs/source");
  const target = path.join(f.workspace, "skills/test");
  await fs.mkdir(extractedRoot, { recursive: true });
  await fs.writeFile(path.join(extractedRoot, "SKILL.md"), skill);
  const input = new PassThrough();
  const { messages } = f;
  const prepared = new Promise<void>((resolve) => {
    f.output.once("data", () => resolve());
  });
  const run = f.run("applyRoot", input);
  input.write(`${JSON.stringify({ extractedRoot, slug: "test", mode: "install" })}\n`);
  await prepared;
  expect(messages).toEqual([{ type: "prepared", mode: "install" }]);
  await missing(target);
  input.end(`${JSON.stringify({ decision: allowed ? null : denial })}\n`);
  await run;
  expect(messages).toHaveLength(2);
  if (allowed) {
    expect(messages[1]).toMatchObject({ type: "result", result: { ok: true, mode: "install" } });
    expect(await fs.readFile(path.join(target, "SKILL.md"), "utf8")).toBe(skill);
  } else {
    expect(messages[1]).toEqual({ type: "result", result: { ok: false, ...denial } });
    await missing(target);
  }
});

it.each([
  { operation: "discovery", error: "does not match the provisioned workspace" },
  { operation: "unknown", error: "Unknown skill worker operation" },
])("rejects $operation before scanning", async ({ operation, error }) => {
  const f = fixture();
  await expect(
    f.invoke(
      operation,
      operation === "discovery" ? { sourcePlan: { workspaceDir: path.join(f.home, "other") } } : {},
    ),
  ).rejects.toThrow(error);
});
