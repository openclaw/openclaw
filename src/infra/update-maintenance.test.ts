import { afterEach, expect, it } from "vitest";
import { formatUpdateCleanupCommand } from "./update-maintenance.js";

const platform = Object.getOwnPropertyDescriptor(process, "platform")!;

afterEach(() => {
  Object.defineProperty(process, "platform", platform);
});

it("prints Windows removal commands with the extended-length prefix PowerShell 5.1 needs past MAX_PATH", () => {
  Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
  expect(
    formatUpdateCleanupCommand(
      "C:\\Users\\o'neil\\AppData\\Local\\Temp\\openclaw-update-runtime-ab12CD",
    ),
  ).toBe(
    "Remove-Item -LiteralPath '\\\\?\\C:\\Users\\o''neil\\AppData\\Local\\Temp\\openclaw-update-runtime-ab12CD' -Recurse -Force",
  );
  expect(formatUpdateCleanupCommand("\\\\server\\share\\openclaw-update-runtime-ab12CD")).toBe(
    "Remove-Item -LiteralPath '\\\\?\\UNC\\server\\share\\openclaw-update-runtime-ab12CD' -Recurse -Force",
  );
});

it("keeps POSIX removal commands unprefixed", () => {
  Object.defineProperty(process, "platform", { configurable: true, value: "linux" });
  expect(formatUpdateCleanupCommand("/tmp/openclaw update")).toBe(
    "rm -rf -- '/tmp/openclaw update'",
  );
});
