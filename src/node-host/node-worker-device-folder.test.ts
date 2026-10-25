import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { NodeHostWorkerRunsSchema } from "../config/zod-schema.node-host.js";
import {
  NODE_WORKSPACE_DRAIN_COMMAND,
  NODE_WORKSPACE_VALIDATE_DEVICE_FOLDER_COMMAND,
} from "../worker/node-workspace-protocol.js";
import { WORKSPACE_INSPECTION_COMMAND } from "../worker/workspace-inspection-protocol.js";
import { NodeWorkerWorkspaceRuntime } from "./node-worker-workspace.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const identity = {
  gatewayNamespace: "gateway-1",
  environmentId: "environment-1",
  sessionId: "session-1",
  generation: 1,
};
const snapshot = {
  version: 1 as const,
  gatewayNamespace: identity.gatewayNamespace,
  controllerId: "controller",
  sequence: 1,
  retain: [],
};
let home = "",
  allowed = "",
  folder = "",
  root = "";
let runtime: NodeWorkerWorkspaceRuntime;
const makeRuntime = (folders?: string[]) =>
  new NodeWorkerWorkspaceRuntime({
    root,
    env: { ...process.env, HOME: home, USERPROFILE: home },
    folders,
  });
const request = () => ({
  gatewayNamespace: identity.gatewayNamespace,
  environmentId: identity.environmentId,
  sessionId: identity.sessionId,
  workspaceDir: folder,
  sessionKey: "session-1",
  ownerEpoch: 1,
});
const exec = (argv: string[], extra: Partial<Parameters<typeof runtime.exec>[0]> = {}) =>
  runtime.exec({ ...identity, deviceFolder: folder, argv, ...extra });
const write = (name = "user.txt", value = "original") =>
  fs.writeFileSync(path.join(folder, name), value);
const outside = () => {
  const dir = path.join(home, "outside");
  fs.mkdirSync(dir);
  return dir;
};
const expectHomes = (homes: string[], expected: boolean[]) =>
  expect(homes.map((dir) => fs.existsSync(dir))).toEqual(expected);
const retain = (
  owner = runtime,
  patch: Partial<Parameters<typeof runtime.applyRetainSnapshot>[0]> = {},
  recovered: Parameters<typeof runtime.applyRetainSnapshot>[1] = async () => [],
) => owner.applyRetainSnapshot({ ...snapshot, ...patch }, recovered);
beforeEach(() => {
  home = tempDirs.make("device-folder-");
  allowed = path.join(home, "projects");
  folder = path.join(allowed, "project");
  root = path.join(home, "state", "node-host");
  fs.mkdirSync(folder, { recursive: true });
  runtime = makeRuntime(["~/projects"]);
});

it("accepts only absolute or home-relative configuration roots", () => {
  expect(
    NodeHostWorkerRunsSchema.parse({ folders: ["~/projects", "/srv/projects", "C:\\projects"] }),
  ).toBeDefined();
  expect(NodeHostWorkerRunsSchema.safeParse({ folders: ["projects"] }).success).toBe(false);
  expect(NodeHostWorkerRunsSchema.safeParse({ folders: ["/tmp\0oops"] }).success).toBe(false);
  expect(NodeHostWorkerRunsSchema.parse({})).not.toHaveProperty("folders");
  expect(NodeHostWorkerRunsSchema.parse({ folders: [] })).toMatchObject({ folders: [] });
});

it.each([
  [() => "~/projects/project", "configured", () => folder],
  [() => allowed, "configured", () => allowed],
  [() => "projects/project", "configured", "absolute"],
  [() => path.join(allowed, "missing"), "configured", "existing"],
  [() => path.join(folder, "file.txt"), "configured", "directory"],
  [() => path.join(allowed, "escape"), "configured", "not allowed"],
  [() => path.join(home, "outside"), "default", () => path.join(home, "outside")],
  [() => path.parse(folder).root, "default", "filesystem root"],
  [() => root, "default", "private worker storage"],
  [() => home, "default", "private worker storage"],
  [() => folder, "disabled", "sessions are disabled"],
] as const)("validates device-folder consent case %#", async (getDir, mode, expected) => {
  runtime = makeRuntime(mode === "default" ? undefined : mode === "disabled" ? [] : [allowed]);
  write("file.txt");
  fs.symlinkSync(outside(), path.join(allowed, "escape"), "dir");
  const result = exec([NODE_WORKSPACE_VALIDATE_DEVICE_FOLDER_COMMAND], { deviceFolder: getDir() });
  if (typeof expected === "string") {
    await expect(result).rejects.toThrow(expected);
  } else {
    await expect(result).resolves.toMatchObject({ workspaceDir: expected() });
  }
});

it("does not reinterpret an unbound legacy worker cwd as a device folder", async () => {
  const { sessionKey: _sessionKey, ...legacy } = request();
  await expect(runtime.acquirePreparedWorkspace(legacy)).resolves.toBeUndefined();
});

it("revalidates a symlink on every operation and does not provision on validation", async () => {
  const alias = path.join(allowed, "alias");
  fs.symlinkSync(folder, alias, "dir");
  const validateAlias = () =>
    exec([NODE_WORKSPACE_VALIDATE_DEVICE_FOLDER_COMMAND], { deviceFolder: alias });
  expect(await validateAlias()).toMatchObject({
    workspaceDir: folder,
    stdout: "validated\n",
  });
  expect([root, folder].map((dir) => fs.readdirSync(dir))).toEqual([[], []]);
  fs.unlinkSync(alias);
  fs.symlinkSync(outside(), alias, "dir");
  await expect(validateAlias()).rejects.toThrow("not allowed");
});

it("executes and inspects in place with private HOME, and leaves user files after retention", async () => {
  write();
  const result = await exec(
    ["node", "-e", "console.log(JSON.stringify({ cwd: process.cwd(), home: process.env.HOME }))"],
    { nativeProcessOwner: true },
  );
  expect(result.code).toBe(0);
  const output = JSON.parse(result.stdout) as { cwd: string; home: string };
  expect(output.cwd).toBe(folder);
  expect(output.home.startsWith(root + path.sep)).toBe(true);
  const inspected = await exec([WORKSPACE_INSPECTION_COMMAND], {
    input: JSON.stringify({
      operation: "get",
      sessionKey: "session-1",
      path: "user.txt",
      files: [{ path: "user.txt", kind: "read" }],
    }),
  });
  expect(inspected.stdout).toContain("original");
  const acquired = await runtime.acquireManagedWorkspaceAsync(request());
  expect(acquired).toMatchObject({ workspaceDir: folder, homeDir: output.home });
  fs.writeFileSync(path.join(acquired.homeDir!, "private.txt"), "private state");
  acquired.release();
  await retain();
  expect(fs.existsSync(output.home)).toBe(false);
  expect(fs.readdirSync(folder)).toEqual(["user.txt"]);
  expect(fs.readFileSync(path.join(folder, "user.txt"), "utf8")).toBe("original");
});

it("retains private homes by gateway and generation, including acquired and recovered owners", async () => {
  write();

  const first = await runtime.acquirePreparedWorkspace(request());
  const second = await runtime.acquirePreparedWorkspace({ ...request(), ownerEpoch: 2 });
  const otherGateway = await runtime.acquirePreparedWorkspace({
    ...request(),
    gatewayNamespace: "gateway-2",
  });
  expect(first?.homeDir).toBeDefined();
  expect(new Set([first?.homeDir, second?.homeDir, otherGateway?.homeDir]).size).toBe(3);
  for (const acquired of [first!, second!, otherGateway!]) {
    fs.writeFileSync(path.join(acquired.homeDir!, "private.txt"), "private state");
  }

  await retain();
  const homes = [first!.homeDir!, second!.homeDir!];
  expectHomes(homes, [true, true]);
  for (const acquired of [first!, first!, second!, otherGateway!]) {
    acquired.release();
  }
  // A fresh runtime must discover the homes without an in-memory registration.
  const restarted = makeRuntime();
  await retain(
    restarted,
    { retain: [{ ...identity, generation: 2, manifestRefs: [] }] },
    async () => [request()],
  );
  expectHomes(homes, [true, true]);
  await retain(restarted, { sequence: 2 });
  expectHomes([...homes, otherGateway!.homeDir!], [false, false, true]);
  await retain(restarted, { gatewayNamespace: "gateway-2" });
  expect(fs.existsSync(otherGateway!.homeDir!)).toBe(false);
  expect(fs.readdirSync(folder)).toEqual(["user.txt"]);
});

it("drains the logical operation queue after the user folder disappears", async () => {
  fs.renameSync(folder, `${folder}-moved`);
  await expect(exec([NODE_WORKSPACE_DRAIN_COMMAND])).resolves.toMatchObject({
    code: 0,
    stdout: "drained\n",
  });
  expect(fs.existsSync(folder)).toBe(false);
});

it("rejects replacement, seeding, transfer, and quiescence even for direct runtime callers", async () => {
  write();
  const key = "a".repeat(64);
  for (const extra of [
    { resetWorkspace: true },
    { resetWorkspace: false },
    { seed: { action: "apply", key } },
    { transfer: { direction: "download", token: "token", manifestRef: `sha256:${key}` } },
    { quiescence: { action: "acquire", nonce: "a".repeat(32), timeoutMs: 1000 } },
  ] as const) {
    await expect(exec(["node", "-e", ""], extra)).rejects.toThrow("device folders cannot");
  }
  expect(fs.readdirSync(folder)).toEqual(["user.txt"]);
});
