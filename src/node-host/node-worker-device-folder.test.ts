import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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
function fixture() {
  const home = tempDirs.make("device-folder-");
  const allowed = path.join(home, "projects");
  const folder = path.join(allowed, "project");
  const root = path.join(home, "state", "node-host");
  fs.mkdirSync(folder, { recursive: true });
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  const runtime = new NodeWorkerWorkspaceRuntime({ root, env, folders: ["~/projects"] });
  return { home, allowed, folder, root, env, runtime };
}

describe("device folder consent", () => {
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
    const { home, allowed, folder, root, env, runtime } = fixture();
    expect(runtime.validateDeviceFolder("~/projects/project")).toBe(folder);
    expect(runtime.validateDeviceFolder(allowed)).toBe(allowed);
    expect(() => runtime.validateDeviceFolder("projects/project")).toThrow("absolute");
    expect(() => runtime.validateDeviceFolder(path.join(allowed, "missing"))).toThrow("existing");
    const file = path.join(folder, "file.txt");
    fs.writeFileSync(file, "user content");
    expect(() => runtime.validateDeviceFolder(file)).toThrow("directory");
    const outside = path.join(home, "outside");
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(allowed, "escape"), "dir");
    expect(() => runtime.validateDeviceFolder(path.join(allowed, "escape"))).toThrow("not allowed");
    const broad = new NodeWorkerWorkspaceRuntime({ root, env, folders: [home] });
    expect(() => broad.validateDeviceFolder(root)).toThrow("private worker storage");
    expect(() => broad.validateDeviceFolder(home)).toThrow("private worker storage");
  });

  it("allows any existing directory by default, but rejects filesystem roots and private storage", () => {
    const { home, folder, root, env } = fixture();
    const runtime = new NodeWorkerWorkspaceRuntime({ root, env });
    const outside = path.join(home, "outside");
    fs.mkdirSync(outside);
    expect(runtime.validateDeviceFolder(outside)).toBe(outside);
    expect(runtime.validateDeviceFolder(folder)).toBe(folder);
    expect(() => runtime.validateDeviceFolder(path.parse(folder).root)).toThrow("filesystem root");
    expect(() => runtime.validateDeviceFolder(root)).toThrow("private worker storage");
    expect(() => runtime.validateDeviceFolder(home)).toThrow("private worker storage");
  });

  it("does not reinterpret an unbound legacy worker cwd as a device folder", async () => {
    const { folder, runtime } = fixture();
    await expect(
      runtime.acquirePreparedWorkspace({
        workspaceDir: folder,
        gatewayNamespace: identity.gatewayNamespace,
        environmentId: identity.environmentId,
        sessionId: identity.sessionId,
        ownerEpoch: 1,
      }),
    ).resolves.toBeUndefined();
  });

  it("disables device-folder validation with an explicit empty list", async () => {
    const { folder, root, env } = fixture();
    const runtime = new NodeWorkerWorkspaceRuntime({ root, env, folders: [] });
    expect(() => runtime.validateDeviceFolder(folder)).toThrow("sessions are disabled");
    await expect(
      runtime.exec({
        ...identity,
        deviceFolder: folder,
        argv: [NODE_WORKSPACE_VALIDATE_DEVICE_FOLDER_COMMAND],
      }),
    ).rejects.toThrow("sessions are disabled");
  });

  it("revalidates a symlink on every operation and does not provision on validation", async () => {
    const { home, allowed, folder, runtime, root } = fixture();
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
    expect(fs.readdirSync(root)).toEqual([]);
    expect(fs.readdirSync(folder)).toEqual([]);
    fs.unlinkSync(alias);
    const outside = path.join(home, "outside");
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, alias, "dir");
    await expect(runtime.exec(input)).rejects.toThrow("not allowed");
  });

  it("executes and inspects in place with private HOME, and leaves user files after retention", async () => {
    const { folder, root, runtime } = fixture();
    fs.writeFileSync(path.join(folder, "user.txt"), "original");
    const result = await runtime.exec({
      ...identity,
      deviceFolder: folder,
      argv: [
        "node",
        "-e",
        "console.log(JSON.stringify({ cwd: process.cwd(), home: process.env.HOME }))",
      ],
      nativeProcessOwner: true,
    });
    expect(result.code).toBe(0);
    const output = JSON.parse(result.stdout) as { cwd: string; home: string };
    expect(output.cwd).toBe(folder);
    expect(output.home.startsWith(root + path.sep)).toBe(true);
    const inspected = await runtime.exec({
      ...identity,
      deviceFolder: folder,
      argv: [WORKSPACE_INSPECTION_COMMAND],
      input: JSON.stringify({
        operation: "get",
        sessionKey: "session-1",
        path: "user.txt",
        files: [{ path: "user.txt", kind: "read" }],
      }),
    });
    expect(inspected.stdout).toContain("original");
    const acquired = await runtime.acquireManagedWorkspaceAsync({
      workspaceDir: folder,
      gatewayNamespace: identity.gatewayNamespace,
      environmentId: identity.environmentId,
      sessionId: identity.sessionId,
      sessionKey: "session-1",
      ownerEpoch: 1,
    });
    expect(acquired.workspaceDir).toBe(folder);
    fs.writeFileSync(path.join(acquired.homeDir!, "private.txt"), "private state");
    acquired.release();
    await runtime.applyRetainSnapshot(
      {
        version: 1,
        gatewayNamespace: identity.gatewayNamespace,
        controllerId: "controller",
        sequence: 1,
        retain: [],
      },
      async () => [],
    );
    expect(fs.existsSync(acquired.homeDir!)).toBe(false);
    expect(fs.existsSync(output.home)).toBe(false);
    expect(acquired.homeDir).toBe(output.home);
    expect(fs.readdirSync(folder)).toEqual(["user.txt"]);
    expect(fs.readFileSync(path.join(folder, "user.txt"), "utf8")).toBe("original");
  });

  it("retains private homes by gateway and generation, including acquired and recovered owners", async () => {
    const { folder, root, env, runtime } = fixture();
    fs.writeFileSync(path.join(folder, "user.txt"), "original");
    const request = {
      workspaceDir: folder,
      gatewayNamespace: identity.gatewayNamespace,
      environmentId: identity.environmentId,
      sessionId: identity.sessionId,
      sessionKey: "session-1",
      ownerEpoch: 1,
    };
    const first = await runtime.acquirePreparedWorkspace(request);
    const second = await runtime.acquirePreparedWorkspace({ ...request, ownerEpoch: 2 });
    const otherGateway = await runtime.acquirePreparedWorkspace({
      ...request,
      gatewayNamespace: "gateway-2",
    });
    expect(first?.homeDir).toBeDefined();
    expect(new Set([first?.homeDir, second?.homeDir, otherGateway?.homeDir]).size).toBe(3);
    for (const acquired of [first!, second!, otherGateway!]) {
      fs.writeFileSync(path.join(acquired.homeDir!, "private.txt"), "private state");
    }
    const snapshot = {
      version: 1 as const,
      gatewayNamespace: request.gatewayNamespace,
      controllerId: "controller",
      sequence: 1,
      retain: [],
    };
    await runtime.applyRetainSnapshot(snapshot, async () => []);
    expect(fs.existsSync(first!.homeDir!)).toBe(true);
    expect(fs.existsSync(second!.homeDir!)).toBe(true);
    first!.release();
    first!.release();
    second!.release();
    otherGateway!.release();
    // A fresh runtime must discover the homes without an in-memory registration.
    const restarted = new NodeWorkerWorkspaceRuntime({ root, env });
    await restarted.applyRetainSnapshot(
      {
        ...snapshot,
        retain: [{ ...identity, generation: 2, manifestRefs: [] }],
      },
      async () => [{ ...request, ownerEpoch: 1 }],
    );
    expect(fs.existsSync(first!.homeDir!)).toBe(true);
    expect(fs.existsSync(second!.homeDir!)).toBe(true);
    await restarted.applyRetainSnapshot({ ...snapshot, sequence: 2 }, async () => []);
    expect(fs.existsSync(first!.homeDir!)).toBe(false);
    expect(fs.existsSync(second!.homeDir!)).toBe(false);
    expect(fs.existsSync(otherGateway!.homeDir!)).toBe(true);
    await restarted.applyRetainSnapshot(
      { ...snapshot, gatewayNamespace: "gateway-2" },
      async () => [],
    );
    expect(fs.existsSync(otherGateway!.homeDir!)).toBe(false);
    expect(fs.readdirSync(folder)).toEqual(["user.txt"]);
  });

  it("drains the logical operation queue after the user folder disappears", async () => {
    const { folder, runtime } = fixture();
    fs.renameSync(folder, `${folder}-moved`);
    await expect(
      runtime.exec({
        ...identity,
        deviceFolder: folder,
        argv: [NODE_WORKSPACE_DRAIN_COMMAND],
      }),
    ).resolves.toMatchObject({ code: 0, stdout: "drained\n" });
    expect(fs.existsSync(folder)).toBe(false);
  });

  it("binds an acquisition to the exact directory, not just an allowed path", () => {
    const { folder, allowed, root, env } = fixture();
    const acquired = new NodeWorkerDeviceFolders({
      env,
      folders: [allowed],
      privateRoots: [root],
    }).acquire({
      workspaceDir: folder,
      environmentId: "environment-1",
      sessionId: "session-1",
      sessionKey: "session-1",
      ownerEpoch: 1,
    });
    acquired.assertCurrent();
    fs.renameSync(folder, `${folder}-original`);
    fs.mkdirSync(folder);
    expect(() => acquired.assertCurrent()).toThrow("acquired device folder changed");
  });

  it("rejects replacement, seeding, transfer, and quiescence even for direct runtime callers", async () => {
    const { folder, runtime } = fixture();
    fs.writeFileSync(path.join(folder, "user.txt"), "original");
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
      await expect(
        runtime.exec({ ...identity, deviceFolder: folder, argv: ["node", "-e", ""], ...extra }),
      ).rejects.toThrow("device folders cannot");
    }
    expect(fs.readdirSync(folder)).toEqual(["user.txt"]);
  });
});
