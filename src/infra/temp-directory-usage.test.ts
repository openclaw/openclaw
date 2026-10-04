import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mockProcessPlatform } from "../test-utils/vitest-spies.js";
import * as census from "./openclaw-process-census.js";
import { inspectTemporaryDirectoryUsage } from "./temp-directory-usage.js";

const { directory, read, link } = vi.hoisted(() => ({
  directory: vi.fn(),
  read: vi.fn(),
  link: vi.fn(),
}));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    default: { ...actual, readdirSync: directory, readFileSync: read, readlinkSync: link },
  };
});

const root = "/tmp/openclaw-plugin-build-unused";
const pid = String(process.pid);
const denied = (code: string) =>
  Object.assign(new Error(`${code}: fixture census denied`), { code });

beforeEach(() => {
  mockProcessPlatform("linux");
  vi.spyOn(census, "inspectOtherOpenClawProcesses").mockReturnValue({ pids: [] });
  directory.mockReset().mockImplementation((file: string) => (file === "/proc" ? [pid] : ["4"]));
  read.mockReset().mockReturnValue("");
  link.mockReset().mockReturnValue("/unrelated/payload");
});
afterEach(() => vi.restoreAllMocks());

it.each(["descriptor", "mapping", "cwd"])(
  "recognizes a %s holder without an OpenClaw argv",
  (kind) => {
    if (kind === "mapping") {
      read.mockReturnValue(`0123-4567 r--p 0000 00:01 42 ${root}/module.node\n`);
    } else {
      link.mockImplementation((file: string) =>
        file.endsWith(kind === "cwd" ? "/cwd" : "/fd/4") ? `${root}/payload` : "/unrelated",
      );
    }
    expect(inspectTemporaryDirectoryUsage(root)).toEqual({ kind: "active" });
  },
);

it("requires a complete census and respects directory boundaries before declaring inactivity", () => {
  link.mockReturnValue(`${root}-neighbor/payload`);
  expect(inspectTemporaryDirectoryUsage(root)).toEqual({ kind: "inactive" });
  directory.mockReturnValue([]);
  expect(inspectTemporaryDirectoryUsage(root)).toMatchObject({
    kind: "unknown",
    reason: expect.stringContaining("incomplete"),
  });
});

it.each(["EACCES", "EPERM", "ENOENT"])("preserves roots when /proc is unavailable (%s)", (code) => {
  directory.mockImplementation(() => {
    throw denied(code);
  });
  expect(inspectTemporaryDirectoryUsage(root)).toEqual({
    kind: "unknown",
    reason: expect.stringContaining(code),
  });
});

it.each(["descriptors", "maps", "cwd"])(
  "refuses incomplete %s evidence for a live process",
  (kind) => {
    if (kind === "descriptors") {
      directory.mockImplementation((file: string) => {
        if (file === "/proc") {
          return [pid];
        }
        throw denied("EACCES");
      });
    } else if (kind === "maps") {
      read.mockImplementation(() => {
        throw denied("EACCES");
      });
    } else {
      link.mockImplementation((file: string) => {
        if (file.endsWith("/cwd")) {
          throw denied("ENOENT");
        }
        return "/unrelated";
      });
    }
    expect(inspectTemporaryDirectoryUsage(root)).toMatchObject({ kind: "unknown" });
  },
);

it("accepts an already closed descriptor but never permission-denied descriptors", () => {
  link.mockImplementation((file: string) => {
    if (file.endsWith("/fd/4")) {
      throw denied("ENOENT");
    }
    return "/unrelated";
  });
  expect(inspectTemporaryDirectoryUsage(root)).toEqual({ kind: "inactive" });
  link.mockImplementation(() => {
    throw denied("EPERM");
  });
  expect(inspectTemporaryDirectoryUsage(root)).toMatchObject({
    kind: "unknown",
    reason: expect.stringContaining("EPERM"),
  });
});

it("preserves the producer census's unknown reason and live producer protection", () => {
  vi.mocked(census.inspectOtherOpenClawProcesses).mockReturnValue({
    error: "Host process visibility is unavailable",
  });
  expect(inspectTemporaryDirectoryUsage(root)).toEqual({
    kind: "unknown",
    reason: "Host process visibility is unavailable",
  });
  vi.mocked(census.inspectOtherOpenClawProcesses).mockReturnValue({ pids: [123] });
  expect(inspectTemporaryDirectoryUsage(root)).toEqual({ kind: "active" });
});

it.each(["darwin", "win32"] as const)(
  "preserves tokenless scratch without open-file inspection on %s",
  (platform) => {
    mockProcessPlatform(platform);
    expect(inspectTemporaryDirectoryUsage(root)).toEqual({
      kind: "unknown",
      reason: expect.stringContaining(platform),
    });
  },
);
