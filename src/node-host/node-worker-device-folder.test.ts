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
import { NodeWorkerDeviceFolders } from "./node-worker-device-folder.js";
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
const validate = (dir: string) => runtime.validateDeviceFolder(dir);
const reject = (dir: string, error: string) => expect(() => validate(dir)).toThrow(error);
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

it("requires an existing directory, configured root containment, and no private-root overlap", () => {
  expect(validate("~/projects/project")).toBe(folder);
  expect(validate(allowed)).toBe(allowed);
  reject("projects/project", "absolute");
  reject(path.join(allowed, "missing"), "existing");
  const file = path.join(folder, "file.txt");
  write("file.txt", "user content");
  reject(file, "directory");
  fs.symlinkSync(outside(), path.join(allowed, "escape"), "dir");
  reject(path.join(allowed, "escape"), "not allowed");
  const broad = makeRuntime([home]);
  expect(() => broad.validateDeviceFolder(root)).toThrow("private worker storage");
  expect(() => broad.validateDeviceFolder(home)).toThrow("private worker storage");
});

it("allows any existing directory by default, but rejects filesystem roots and private storage", () => {
  runtime = makeRuntime();
  const dir = outside();
  expect(validate(dir)).toBe(dir);
  expect(validate(folder)).toBe(folder);
  reject(path.parse(folder).root, "filesystem root");
  reject(root, "private worker storage");
  reject(home, "private worker storage");
});

it("does not reinterpret an unbound legacy worker cwd as a device folder", async () => {
  const { sessionKey: _sessionKey, ...legacy } = request();
  await expect(runtime.acquirePreparedWorkspace(legacy)).resolves.toBeUndefined();
});

it("disables device-folder validation with an explicit empty list", async () => {
  runtime = makeRuntime([]);
  expect(() => runtime.validateDeviceFolder(folder)).toThrow("sessions are disabled");
  await expect(exec([NODE_WORKSPACE_VALIDATE_DEVICE_FOLDER_COMMAND])).rejects.toThrow(
    "sessions are disabled",
  );
});

it("revalidates a symlink on every operation and does not provision on validation", async () => {
  const alias = path.join(allowed, "alias");
  fs.symlinkSync(folder, alias, "dir");
  const input = {
    ...identity,
    deviceFolder: alias,
    argv: [NODE_WORKSPACE_VALIDATE_DEVICE_FOLDER_COMMAND],
  };
  expect(await runtime.exec(input)).toMatchObject({
    workspaceDir: folder,
    stdout: "validated\n",
  });
  expect([root, folder].map((dir) => fs.readdirSync(dir))).toEqual([[], []]);
  fs.unlinkSync(alias);
  fs.symlinkSync(outside(), alias, "dir");
  await expect(runtime.exec(input)).rejects.toThrow("not allowed");
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
  expectHomes([acquired.homeDir!, output.home], [false, false]);
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

it("binds an acquisition to the exact directory, not just an allowed path", () => {
  const acquired = new NodeWorkerDeviceFolders({
    env: { ...process.env, HOME: home, USERPROFILE: home },
    folders: [allowed],
    privateRoots: [root],
  }).acquire(request());
  acquired.assertCurrent();
  fs.renameSync(folder, `${folder}-original`);
  fs.mkdirSync(folder);
  expect(() => acquired.assertCurrent()).toThrow("acquired device folder changed");
});

it("rejects replacement, seeding, transfer, and quiescence even for direct runtime callers", async () => {
  write();
  for (const extra of [
    { resetWorkspace: true },
    { resetWorkspace: false },
    { seed: { action: "apply", key: "a".repeat(64) } },
    {
      transfer: {
        direction: "download",
        token: "token",
        manifestRef: `sha256:${"a".repeat(64)}`,
        attachments: true,
      },
    },
    { quiescence: { action: "acquire", nonce: "a".repeat(32), timeoutMs: 1000 } },
  ] as const) {
    await expect(exec(["node", "-e", ""], extra)).rejects.toThrow("device folders cannot");
  }
  expect(fs.readdirSync(folder)).toEqual(["user.txt"]);
});
