import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerNodesCameraCommands } from "../../cli/nodes-cli/register.camera.js";
import { executeNodeMediaAction } from "./nodes-tool-media.js";

const mocks = vi.hoisted(() => ({
  root: "",
  nextPath: 0,
  invoke: vi.fn(),
  sanitize: vi.fn(),
  output: vi.fn(),
  remove: vi.fn(),
}));

vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<
    typeof import("node:fs/promises") & { default: typeof import("node:fs/promises") }
  >("node:fs/promises");
  const rm = async (
    filePath: Parameters<typeof actual.rm>[0],
    options?: Parameters<typeof actual.rm>[1],
  ) => {
    await mocks.remove(filePath);
    return await actual.rm(filePath, options);
  };
  return { ...actual, rm, default: actual.default };
});
vi.mock("../../cli/nodes-camera.js", async () => {
  const actual = await vi.importActual<typeof import("../../cli/nodes-camera.js")>(
    "../../cli/nodes-camera.js",
  );
  return {
    ...actual,
    cameraTempPath: (opts: Parameters<typeof actual.cameraTempPath>[0]) =>
      actual.cameraTempPath({ ...opts, tmpDir: mocks.root, id: `batch-${++mocks.nextPath}` }),
  };
});
vi.mock("./nodes-utils.js", () => ({
  resolveAgentNode: async () => ({ nodeId: "test-node", platform: "ios" }),
  resolveAgentNodeId: async () => "test-node",
}));
vi.mock("./nodes-tool-invoke.js", () => ({
  callNodesToolNodeInvoke: (...args: unknown[]) => mocks.invoke(...args),
  resolveNodesToolInvokeTimeouts: vi.fn(),
}));
vi.mock("../tool-images.js", () => ({
  sanitizeToolResultImages: (...args: unknown[]) => mocks.sanitize(...args),
}));
vi.mock("../../cli/nodes-cli/cli-utils.js", async () => {
  const actual = await vi.importActual<typeof import("../../cli/nodes-cli/cli-utils.js")>(
    "../../cli/nodes-cli/cli-utils.js",
  );
  return {
    ...actual,
    runNodesCommand: async (_label: string, action: () => Promise<void>) => action(),
  };
});
vi.mock("../../cli/nodes-cli/rpc.js", async () => {
  const actual = await vi.importActual<typeof import("../../cli/nodes-cli/rpc.js")>(
    "../../cli/nodes-cli/rpc.js",
  );
  return {
    ...actual,
    resolveCliNode: async () => ({ nodeId: "test-node", platform: "ios" }),
    callNodesGatewayCli: (...args: unknown[]) => mocks.invoke(...args),
  };
});
vi.mock("../../runtime.js", () => ({
  defaultRuntime: {
    log: vi.fn(),
    error: vi.fn(),
    writeJson: (...args: unknown[]) => mocks.output(...args),
    exit: vi.fn(),
  },
}));

const photo = {
  format: "jpg",
  base64: Buffer.from("private photo").toString("base64"),
  width: 1,
  height: 1,
};
type Owner = "camera_snap" | "photos_latest" | "cli";
const owners: Owner[] = ["camera_snap", "photos_latest", "cli"];

function requireFixture<T>(value: T | null | undefined): T {
  if (value === undefined || value === null) {
    throw new Error("expected captured fixture value");
  }
  return value;
}

function configure(owner: Owner) {
  mocks.invoke.mockResolvedValue({
    payload: owner === "photos_latest" ? { photos: [photo, photo] } : photo,
  });
}
async function run(owner: Owner) {
  if (owner === "cli") {
    const nodes = new Command("nodes");
    registerNodesCameraCommands(nodes);
    await nodes.parseAsync([
      "node",
      "nodes",
      "camera",
      "snap",
      "--node",
      "test-node",
      "--facing",
      "both",
      "--json",
    ]);
    return null;
  }
  return await executeNodeMediaAction({
    action: owner,
    params: { node: "test-node", facing: "both", limit: 2 },
    gatewayOpts: {},
    modelHasVision: false,
    imageSanitization: {},
  });
}

describe("node photo batch filesystem ownership", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    mocks.root = await fs.mkdtemp(path.join(os.tmpdir(), "node-media-rollback-"));
    mocks.nextPath = 0;
    mocks.sanitize.mockImplementation(async (result) => result);
    mocks.output.mockImplementation(() => {});
    mocks.remove.mockResolvedValue(undefined);
    await fs.writeFile(path.join(mocks.root, "unrelated.jpg"), "keep me");
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    mocks.remove.mockResolvedValue(undefined);
    await fs.rm(mocks.root, { recursive: true, force: true });
  });

  it.each(owners)(
    "rolls back the successful prefix after a later atomic write fails: %s",
    async (owner) => {
      configure(owner);
      const failure = new Error("second publication failed");
      const rename = fs.rename.bind(fs);
      const destinations: string[] = [];
      vi.spyOn(fs, "rename").mockImplementation(async (source, destination) => {
        const target = String(destination);
        if (path.basename(target).startsWith("openclaw-camera-snap")) {
          destinations.push(target);
          if (destinations.length === 2) {
            expect(await fs.readFile(requireFixture(destinations[0]), "utf8")).toBe(
              "private photo",
            );
            throw failure;
          }
        }
        return await rename(source, destination);
      });
      await expect(run(owner)).rejects.toBe(failure);
      expect(destinations).toHaveLength(2);
      await expect(fs.stat(requireFixture(destinations[0]))).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(await fs.readdir(mocks.root)).toEqual(["unrelated.jpg"]);
      expect(await fs.readFile(path.join(mocks.root, "unrelated.jpg"), "utf8")).toBe("keep me");
    },
  );

  it.each(["camera_snap", "photos_latest"] as const)(
    "rolls back after final result sanitizer rejects: %s",
    async (owner) => {
      configure(owner);
      const failure = new Error("sanitizer failed");
      let paths: string[] = [];
      mocks.sanitize.mockImplementation(async (result) => {
        paths = result.details.media.mediaUrls;
        expect(await Promise.all(paths.map((p) => fs.readFile(p, "utf8")))).toEqual([
          "private photo",
          "private photo",
        ]);
        throw failure;
      });
      await expect(run(owner)).rejects.toBe(failure);
      expect(paths).toHaveLength(2);
      for (const p of paths) {
        await expect(fs.stat(p)).rejects.toMatchObject({ code: "ENOENT" });
      }
      expect(await fs.readdir(mocks.root)).toEqual(["unrelated.jpg"]);
    },
  );

  it.each(owners)(
    "retains all successful returned files without overwriting preexisting paths: %s",
    async (owner) => {
      configure(owner);
      const name =
        owner === "photos_latest"
          ? "openclaw-camera-snap-batch-1.jpg"
          : "openclaw-camera-snap-front-batch-1.jpg";
      const existing = path.join(mocks.root, name);
      await fs.writeFile(existing, "preexisting");
      const result = await run(owner);
      const paths: string[] =
        owner === "cli"
          ? requireFixture(mocks.output.mock.calls[0])[0].files.map(
              (file: { path: string }) => file.path,
            )
          : (requireFixture(result).details as { media: { mediaUrls: string[] } }).media.mediaUrls;
      expect(paths).toHaveLength(2);
      expect(new Set(paths).size).toBe(2);
      expect(await Promise.all(paths.map((p) => fs.readFile(p, "utf8")))).toEqual([
        "private photo",
        "private photo",
      ]);
      expect(await fs.readFile(existing, "utf8")).toBe("preexisting");
      expect(await fs.readFile(path.join(mocks.root, "unrelated.jpg"), "utf8")).toBe("keep me");
    },
  );

  it("preserves foreign entries inside a failed batch directory without sweeping", async () => {
    configure("photos_latest");
    const failure = new Error("sanitize");
    let foreign = "";
    mocks.sanitize.mockImplementation(async (result) => {
      foreign = path.join(path.dirname(result.details.media.mediaUrls[0]), "foreign.txt");
      await fs.writeFile(foreign, "foreign");
      throw failure;
    });
    await expect(run("photos_latest")).rejects.toBe(failure);
    expect(await fs.readFile(foreign, "utf8")).toBe("foreign");
    expect(await fs.readdir(path.dirname(foreign))).toEqual(["foreign.txt"]);
  });

  it("continues cleanup after one unlink failure and rethrows the original error", async () => {
    configure("photos_latest");
    const primary = new Error("sanitize");
    const cleanup = new Error("unlink denied");
    let paths: string[] = [];
    mocks.sanitize.mockImplementation(async (result) => {
      paths = result.details.media.mediaUrls;
      mocks.remove.mockImplementation(async (p) => {
        if (String(p) === paths[0]) {
          throw cleanup;
        }
      });
      throw primary;
    });
    await expect(run("photos_latest")).rejects.toBe(primary);
    expect(await fs.readFile(requireFixture(paths[0]), "utf8")).toBe("private photo");
    await expect(fs.stat(requireFixture(paths[1]))).rejects.toMatchObject({ code: "ENOENT" });
    expect(mocks.remove.mock.calls.filter(([p]) => paths.includes(String(p)))).toHaveLength(2);
  });

  it.each(owners)(
    "keeps complete input validation before any artifact write: %s",
    async (owner) => {
      configure(owner);
      const invalid = { ...photo, base64: "not base64!" };
      if (owner === "photos_latest") {
        mocks.invoke.mockResolvedValue({ payload: { photos: [photo, invalid] } });
      } else {
        mocks.invoke
          .mockResolvedValueOnce({ payload: photo })
          .mockResolvedValueOnce({ payload: invalid });
      }
      await expect(run(owner)).rejects.toThrow(/invalid base64/i);
      expect(await fs.readdir(mocks.root)).toEqual(["unrelated.jpg"]);
    },
  );

  it("does not create an output directory for an empty library", async () => {
    mocks.invoke.mockResolvedValue({ payload: { photos: [] } });
    await run("photos_latest");
    expect(await fs.readdir(mocks.root)).toEqual(["unrelated.jpg"]);
  });
});
