import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { importFreshModule } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { readImageMetadataFromHeader } from "../media/image-ops.js";

const runExecMock = vi.hoisted(() => vi.fn());
vi.mock("../process/exec.js", () => ({ runExec: runExecMock }));

// Synthetic 1×1 PNG; directory attributes need not dictate the decoded format.
const photo = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=",
  "base64",
);
let resolveHostAccountAvatar: typeof import("./host-account-avatar.js").resolveHostAccountAvatar;
let freshModuleId = 0;
let tempDir: string | undefined;

beforeEach(async () => {
  ({ resolveHostAccountAvatar } = await importFreshModule<
    typeof import("./host-account-avatar.js")
  >(import.meta.url, `./host-account-avatar.js?test=${freshModuleId++}`));
  vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
});

afterEach(async () => {
  runExecMock.mockReset();
  vi.restoreAllMocks();
  if (tempDir) {
    await fs.rm(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
});

it("decodes directory hex into a browser image and shares concurrent lookups", async () => {
  runExecMock.mockResolvedValue({
    stdout: `JPEGPhoto:\n ${photo.toString("hex").replace(/(.{8})/gu, "$1 ")}\n`,
  });
  const [first, second] = await Promise.all([
    resolveHostAccountAvatar(),
    resolveHostAccountAvatar(),
  ]);
  expect(first).toBe(second);
  expect(first?.mime).toBe("image/jpeg");
  expect(readImageMetadataFromHeader(first!.bytes)).toEqual({ width: 1, height: 1 });
  expect(first?.sha256).toMatch(/^[\da-f]{64}$/u);
  expect(runExecMock).toHaveBeenCalledOnce();
  expect(runExecMock.mock.calls[0]?.[2]).toMatchObject({ timeoutMs: 1000, logOutput: false });
});

it.each([
  { label: "inline", prefix: "Picture: ", symlink: false },
  { label: "multiline", prefix: "Picture:\n ", symlink: false },
  { label: "symlink", prefix: "Picture:\n ", symlink: true },
])("reads a stock Picture path with spaces ($label)", async ({ prefix, symlink }) => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "host-avatar-"));
  const filePath = path.join(tempDir, "Stock Photo.png");
  if (symlink) {
    const targetPath = path.join(tempDir, "photo.png");
    await fs.writeFile(targetPath, photo);
    await fs.symlink(targetPath, filePath);
  } else {
    await fs.writeFile(filePath, photo);
  }
  runExecMock
    .mockRejectedValueOnce(new Error("attribute missing"))
    .mockResolvedValueOnce({ stdout: `${prefix}${filePath}\n` });
  const avatar = await resolveHostAccountAvatar();
  expect(avatar?.mime).toBe("image/jpeg");
  expect(readImageMetadataFromHeader(avatar!.bytes)).toEqual({ width: 1, height: 1 });
});

it.each(["f", "ff zz", "ab".repeat(1024 * 1024 + 1), "010203", "unavailable", "linux"])(
  "caches malformed, unavailable, or unsupported photos (%#)",
  async (input) => {
    if (input === "linux") {
      vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    }
    if (input === "unavailable") {
      runExecMock.mockRejectedValue(new Error("directory unavailable"));
    } else {
      runExecMock.mockResolvedValue({ stdout: `JPEGPhoto: ${input}` });
    }
    await expect(resolveHostAccountAvatar()).resolves.toBeNull();
    await expect(resolveHostAccountAvatar()).resolves.toBeNull();
    if (input === "linux" || input === "unavailable") {
      expect(runExecMock).toHaveBeenCalledTimes(input === "linux" ? 0 : 2);
    }
  },
);
