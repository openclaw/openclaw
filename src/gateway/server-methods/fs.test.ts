import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FsListDirResult } from "../../../packages/gateway-protocol/src/index.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { fsHandlers } from "./fs.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

async function call(
  params: Record<string, unknown>,
  context: Record<string, unknown> = {
    getRuntimeConfig: () => ({}),
    nodeRegistry: { get: vi.fn(), invoke: vi.fn() },
  },
  client: Record<string, unknown> = { connect: { scopes: ["operator.admin"] } },
) {
  const respond = vi.fn();
  await fsHandlers["fs.listDir"]?.({ params, respond, context, client } as never);
  return expectDefined(respond.mock.calls[0], "fs.listDir response");
}

const writeClient = { connect: { scopes: ["operator.write"] } };

function workspaceContext(workspace: string) {
  return {
    getRuntimeConfig: () => ({
      agents: { entries: { main: { workspace } } },
    }),
    nodeRegistry: { get: vi.fn(), invoke: vi.fn() },
  };
}

const connectedNode = {
  connId: "conn-1",
  nodeId: "macbook",
  platform: "macos",
  deviceFamily: "Mac",
  commands: ["fs.listDir"],
};
function nodeContext(
  invoke: ReturnType<typeof vi.fn>,
  node: Record<string, unknown> | null = connectedNode,
  config = {},
) {
  return {
    getRuntimeConfig: () => config,
    nodeRegistry: { get: vi.fn().mockReturnValue(node ?? undefined), invoke },
  };
}

describe("fs.listDir", () => {
  it.each(["operator.admin", "operator.write"])(
    "reopens the exact returned directory path with %s",
    async (scope) => {
      const root = fsSync.realpathSync(tempDirs.make("openclaw-fs-path-identity-"));
      await fs.mkdir(path.join(root, "Project", "ordinary-child"), { recursive: true });
      await fs.mkdir(path.join(root, "Project ", "spaced-child"), { recursive: true });
      const context = workspaceContext(root);
      const client = { connect: { scopes: [scope] } };
      const [listed, initial] = await call({ path: root }, context, client);
      expect(listed).toBe(true);
      const selected = expectDefined(
        (initial as FsListDirResult).entries.find((entry) => entry.name === "Project "),
        "directory with a trailing space",
      );
      const [opened, result] = await call({ path: selected.path }, context, client);
      expect(opened).toBe(true);
      expect(result).toMatchObject({
        path: selected.path,
        entries: [{ name: "spaced-child", path: path.join(selected.path, "spaced-child") }],
      });
    },
  );

  it("lists only directories, visible before hidden, in byte order", async () => {
    const root = tempDirs.make("openclaw-fs-listdir-");
    await fs.mkdir(path.join(root, "zeta"));
    await fs.mkdir(path.join(root, "alpha"));
    await fs.mkdir(path.join(root, ".hidden"));
    await fs.writeFile(path.join(root, "file.txt"), "not a directory");

    const [ok, result] = expectDefined(
      await call({ path: root }),
      "await call({ path: root }) test invariant",
    );
    expect(ok).toBe(true);
    expect(result).toEqual({
      path: root,
      parent: path.dirname(root),
      home: os.homedir(),
      entries: [
        { name: "alpha", path: path.join(root, "alpha") },
        { name: "zeta", path: path.join(root, "zeta") },
        { name: ".hidden", path: path.join(root, ".hidden"), hidden: true },
      ],
    });
  });

  it("follows directory symlinks and skips file or broken symlinks", async () => {
    const root = tempDirs.make("openclaw-fs-listdir-");
    await fs.mkdir(path.join(root, "real"));
    await fs.writeFile(path.join(root, "plain.txt"), "file");
    fsSync.symlinkSync(path.join(root, "real"), path.join(root, "linked-dir"));
    fsSync.symlinkSync(path.join(root, "plain.txt"), path.join(root, "linked-file"));
    fsSync.symlinkSync(path.join(root, "missing"), path.join(root, "broken"));

    const [ok, result] = expectDefined(
      await call({ path: root }),
      "await call({ path: root }) test invariant",
    );
    expect(ok).toBe(true);
    expect((result as { entries: Array<{ name: string }> }).entries.map((e) => e.name)).toEqual([
      "linked-dir",
      "real",
    ]);
  });

  it("defaults to the host home directory", async () => {
    const [ok, result] = expectDefined(await call({}), "await call({}) test invariant");
    expect(ok).toBe(true);
    expect((result as { path: string }).path).toBe(os.homedir());
    expect((result as { home: string }).home).toBe(os.homedir());
  });

  it("rejects relative paths and invalid params", async () => {
    const [relativeOk, , relativeError] = await call({ path: "relative/dir" });
    expect(relativeOk).toBe(false);
    expect(String((relativeError as { message?: string })?.message)).toContain("absolute");

    const [invalidOk] = await call({ path: 42 });
    expect(invalidOk).toBe(false);
  });

  it("reports missing directories as request errors", async () => {
    const root = tempDirs.make("openclaw-fs-listdir-");
    const missing = path.join(root, "does-not-exist");
    const [ok, , error] = expectDefined(
      await call({ path: missing }),
      "missing directory response",
    );
    expect(ok).toBe(false);
    const message = (error as { message?: string })?.message ?? "";
    expect(message).toContain(`ENOENT: no such file or directory, scandir '${missing}'`);
    expect(message).toMatch(/ \| ENOENT$/u);
    expect(message).not.toMatch(/^Error:/u);
  });

  it("allows write-scoped browsing inside a configured workspace", async () => {
    const workspace = tempDirs.make("openclaw-fs-workspace-");
    const nested = path.join(workspace, "packages");
    await fs.mkdir(nested);

    const [ok, result] = expectDefined(
      await call({ path: nested }, workspaceContext(workspace), writeClient),
      "write-scoped workspace listing",
    );

    expect(ok).toBe(true);
    expect(result).toMatchObject({ path: nested, parent: workspace });
  });

  it("defaults write-scoped browsing to the workspace root and clamps its parent", async () => {
    const workspace = tempDirs.make("openclaw-fs-workspace-");

    const [ok, result] = await call({}, workspaceContext(workspace), writeClient);

    expect(ok).toBe(true);
    expect(result).toMatchObject({ path: workspace });
    expect(result).not.toHaveProperty("parent");
  });

  it.each(["outside", "symlink escape"])("rejects write-scoped browsing via %s", async (route) => {
    const workspace = tempDirs.make("openclaw-fs-workspace-");
    const outside = tempDirs.make("openclaw-fs-outside-");
    const target = route === "outside" ? outside : path.join(workspace, "escape");
    if (route !== "outside") {
      fsSync.symlinkSync(outside, target);
    }
    const [ok, , error] = await call({ path: target }, workspaceContext(workspace), writeClient);
    expect(ok).toBe(false);
    expect(error).toMatchObject({ message: expect.stringContaining("operator.admin") });
  });

  it("keeps missing workspace descendants as filesystem errors instead of scope errors", async () => {
    const workspace = tempDirs.make("openclaw-fs-workspace-");
    const missing = path.join(workspace, "missing", "child");

    const [ok, , error] = await call({ path: missing }, workspaceContext(workspace), writeClient);

    expect(ok).toBe(false);
    const message = (error as { message?: string })?.message ?? "";
    expect(message).toContain(`ENOENT: no such file or directory, scandir '${missing}'`);
    expect(message).toMatch(/ \| ENOENT$/u);
    expect(message).not.toMatch(/^Error:/u);
  });

  it("routes node listings through the connected node capability", async () => {
    const invoke = vi.fn().mockResolvedValue({
      ok: true,
      payloadJSON: JSON.stringify({
        path: "/Users/peter",
        home: "/Users/peter",
        entries: [],
      }),
    });
    const context = nodeContext(invoke, {
      ...connectedNode,
      pairingGeneration: "generation-1",
      commands: ["system.run", "fs.listDir"],
    });

    const [ok, result] = await call({ nodeId: "macbook" }, context);

    expect(ok).toBe(true);
    expect(result).toMatchObject({ path: "/Users/peter", home: "/Users/peter" });
    expect(invoke).toHaveBeenCalledWith({
      nodeId: "macbook",
      expectedConnId: "conn-1",
      expectedPairingGeneration: "generation-1",
      command: "fs.listDir",
      params: {},
    });
  });

  it("keeps node path errors as request errors and transport failures as unavailable", async () => {
    const missing = "Error: ENOENT: no such file or directory, scandir '/Users/de'";
    const invoke = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, error: { code: "INVALID_REQUEST", message: missing } })
      .mockResolvedValueOnce({ ok: false, error: { code: "TIMEOUT", message: "node timed out" } });
    const context = nodeContext(invoke);
    expect((await call({ nodeId: "macbook", path: "/Users/de" }, context))[2]).toMatchObject({
      code: "INVALID_REQUEST",
      message: missing,
    });
    expect((await call({ nodeId: "macbook" }, context))[2]).toMatchObject({
      code: "UNAVAILABLE",
      message: "node timed out",
    });
  });

  it("rejects node listings blocked by the live command policy", async () => {
    const invoke = vi.fn();
    const context = nodeContext(invoke, undefined, {
      gateway: { nodes: { commands: { deny: ["fs.listDir"] } } },
    });

    const [ok, , error] = await call({ nodeId: "macbook" }, context);

    expect(ok).toBe(false);
    expect(error).toMatchObject({
      code: "INVALID_REQUEST",
      details: { command: "fs.listDir", reason: "command not allowlisted" },
    });
    expect(invoke).not.toHaveBeenCalled();
  });

  it.each([
    ["offline", null, { code: "UNAVAILABLE" }],
    [
      "old-node",
      { connId: "conn-2", commands: ["system.run"] },
      {
        code: "INVALID_REQUEST",
        message: expect.stringContaining("does not support"),
      },
    ],
  ] as const)("rejects unavailable directory browsing on %s", async (nodeId, node, error) => {
    expect(await call({ nodeId }, nodeContext(vi.fn(), node))).toMatchObject([
      false,
      undefined,
      error,
    ]);
  });
});
