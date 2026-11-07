import fs from "node:fs/promises";
import path from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { registerNodesCli } from "../../cli/nodes-cli/register.js";
import { executeNodeMediaAction } from "./nodes-tool-media.js";

const mocks = vi.hoisted(() => ({
  root: "",
  nextPath: 0,
  invoke: vi.fn(),
  sanitize: vi.fn(),
  output: vi.fn(),
  remove: vi.fn(),
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("node:fs/promises") & { default: typeof import("node:fs/promises") }
  >();
  const rm = async (
    filePath: Parameters<typeof actual.rm>[0],
    options?: Parameters<typeof actual.rm>[1],
  ) => {
    await mocks.remove(filePath);
    return await actual.rm(filePath, options);
  };
  return { ...actual, rm, default: actual.default };
});
vi.mock("../../cli/nodes-camera.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../cli/nodes-camera.js")>();
  return {
    ...actual,
    cameraTempPath: (opts: Parameters<typeof actual.cameraTempPath>[0]) =>
      actual.cameraTempPath({ ...opts, tmpDir: mocks.root, id: `batch-${++mocks.nextPath}` }),
  };
});
// mock-isolation: Supply a deterministic paired node without a live Gateway.
vi.mock("./nodes-utils.js", () => ({
  resolveAgentNode: async () => ({ nodeId: "test-node", platform: "ios" }),
  resolveAgentNodeId: async () => "test-node",
}));
// mock-isolation: Supply deterministic node responses without a live Gateway.
vi.mock("./nodes-tool-invoke.js", () => ({
  callNodesToolNodeInvoke: (...args: unknown[]) => mocks.invoke(...args),
  resolveNodesToolInvokeTimeouts: vi.fn(),
}));
// mock-isolation: Inject final-result sanitizer failures after every photo is written.
vi.mock("../tool-images.js", () => ({
  sanitizeToolResultImages: (...args: unknown[]) => mocks.sanitize(...args),
}));
vi.mock("../../cli/nodes-cli/cli-utils.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../cli/nodes-cli/cli-utils.js")>();
  return {
    ...actual,
    runNodesCommand: async (_label: string, action: () => Promise<void>) => action(),
  };
});
vi.mock("../../cli/nodes-cli/rpc.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../cli/nodes-cli/rpc.js")>();
  return {
    ...actual,
    resolveCliNode: async () => ({ nodeId: "test-node", platform: "ios" }),
    callNodesGatewayCli: (...args: unknown[]) => mocks.invoke(...args),
  };
});
vi.mock("../../runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime.js")>()),
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
const readText = (file: string) => fs.readFile(file, "utf8");
const readPhotos = (files: string[]) => Promise.all(files.map(readText));
const expectMissing = (file: string) =>
  expect(fs.stat(file)).rejects.toMatchObject({ code: "ENOENT" });
const expectUntouched = async () => {
  expect(await fs.readdir(mocks.root)).toEqual(["unrelated.jpg"]);
  expect(await readText(path.join(mocks.root, "unrelated.jpg"))).toBe("keep me");
};

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
    const program = new Command();
    await registerNodesCli(program, ["node", "openclaw", "nodes", "camera"]);
    const nodes = program.commands.find((command) => command.name() === "nodes");
    if (!nodes) {
      throw new Error("expected nodes command to be registered");
    }
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

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

beforeEach(async () => {
  vi.clearAllMocks();
  mocks.root = tempDirs.make("node-media-rollback-");
  mocks.nextPath = 0;
  mocks.sanitize.mockImplementation(async (result) => result);
  mocks.output.mockImplementation(() => {});
  mocks.remove.mockResolvedValue(undefined);
  await fs.writeFile(path.join(mocks.root, "unrelated.jpg"), "keep me");
});
afterEach(() => {
  vi.restoreAllMocks();
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
          expect(await readText(requireFixture(destinations[0]))).toBe("private photo");
          throw failure;
        }
      }
      return await rename(source, destination);
    });
    await expect(run(owner)).rejects.toBe(failure);
    expect(destinations).toHaveLength(2);
    await expectMissing(requireFixture(destinations[0]));
    await expectUntouched();
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
      expect(await readPhotos(paths)).toEqual(["private photo", "private photo"]);
      throw failure;
    });
    await expect(run(owner)).rejects.toBe(failure);
    expect(paths).toHaveLength(2);
    for (const p of paths) {
      await expectMissing(p);
    }
    await expectUntouched();
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
    expect(await readPhotos(paths)).toEqual(["private photo", "private photo"]);
    expect(await readText(existing)).toBe("preexisting");
    expect(await readText(path.join(mocks.root, "unrelated.jpg"))).toBe("keep me");
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
  expect(await readText(foreign)).toBe("foreign");
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
  expect(await readText(requireFixture(paths[0]))).toBe("private photo");
  await expectMissing(requireFixture(paths[1]));
  expect(mocks.remove.mock.calls.filter(([p]) => paths.includes(String(p)))).toHaveLength(2);
});

it.each(owners)("keeps complete input validation before any artifact write: %s", async (owner) => {
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
  await expectUntouched();
});

it("does not create an output directory for an empty library", async () => {
  mocks.invoke.mockResolvedValue({ payload: { photos: [] } });
  await run("photos_latest");
  await expectUntouched();
});
