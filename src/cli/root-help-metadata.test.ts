// Precomputed help preserves field selection, physical-file snapshots, and stdout bytes.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";

const { readMetadata, write } = vi.hoisted(() => ({
  readMetadata: vi.fn(),
  write: vi.fn<typeof process.stdout.write>(),
}));
vi.mock("./startup-metadata.js", () => ({ readCliStartupMetadata: readMetadata }));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const metadata = {
  rootHelpText: " root \n",
  browserHelpText: " browser \n",
  secretsHelpText: " secrets \n",
  nodesHelpText: " nodes \n",
  config: "not nested config",
  subcommandHelpText: {
    rootHelpText: "not flat root",
    config: " config \n",
    doctor: " doctor \n",
    gateway: " gateway \n",
    models: " models \n",
    plugins: " plugins \n",
    sessions: " sessions \n",
  },
};
let help: typeof import("./root-help-metadata.js");

beforeEach(async () => {
  vi.resetModules();
  readMetadata.mockReset().mockReturnValue(metadata);
  write.mockReset().mockReturnValue(true);
  vi.spyOn(process.stdout, "write").mockImplementation(write);
  help = await import("./root-help-metadata.js");
});
afterEach(() => vi.restoreAllMocks());

describe("precomputed help metadata output", () => {
  it.each([
    ["browser", " browser \n"],
    ["secrets", " secrets \n"],
    ["nodes", " nodes \n"],
    ["config", " config \n"],
    ["doctor", " doctor \n"],
    ["gateway", " gateway \n"],
    ["models", " models \n"],
    ["plugins", " plugins \n"],
    ["sessions", " sessions \n"],
  ] as const)("preserves %s bytes", (name, text) => {
    expect(help.outputPrecomputedCommandHelpText(name)).toBe(true);
    expect(write.mock.calls).toEqual([[text]]);
  });

  it("preserves root help bytes", () => {
    expect(help.outputPrecomputedRootHelpText()).toBe(true);
    expect(write.mock.calls).toEqual([[" root \n"]]);
  });

  it("uses the physical reader snapshot across root and nested help", async () => {
    const parentDir = tempDirs.make("openclaw-help-metadata-");
    const moduleDir = path.join(parentDir, "chunks");
    fs.mkdirSync(moduleDir);
    const metadataPath = path.join(parentDir, "cli-startup-metadata.json");
    fs.writeFileSync(metadataPath, JSON.stringify(metadata));
    const moduleUrl = pathToFileURL(path.join(moduleDir, "root-help-metadata.js")).href;
    const { readCliStartupMetadata } =
      await vi.importActual<typeof import("./startup-metadata.js")>("./startup-metadata.js");
    readMetadata.mockImplementation(() => readCliStartupMetadata(moduleUrl));

    expect(help.outputPrecomputedRootHelpText()).toBe(true);
    fs.writeFileSync(metadataPath, JSON.stringify({ rootHelpText: "changed" }));
    expect(help.outputPrecomputedCommandHelpText("config")).toBe(true);
    expect(help.outputPrecomputedRootHelpText()).toBe(true);
    expect(write.mock.calls).toEqual([[" root \n"], [" config \n"], [" root \n"]]);
  });
});
