import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { runCommandWithTimeoutMock } = vi.hoisted(() => ({
  runCommandWithTimeoutMock: vi.fn(),
}));

vi.mock("../process/exec.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../process/exec.js")>()),
  runCommandWithTimeout: runCommandWithTimeoutMock,
}));

const { testing } = await import("./invoke.test-support.js");

const PAYLOAD = 'echo "https://tenant.example.com/"';
const SWITCHES = ["/d", "/s", "/c"] as const;

const originalPlatform = process.platform;
const originalSystemRoot = process.env.SystemRoot;
const originalWindir = process.env.WINDIR;

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
}

/** Drives the real runCommand wiring and returns what reached the shared runner. */
async function captureRunnerCall(
  argv: string[],
): Promise<{ argv: string[]; options: Record<string, unknown> }> {
  await testing.runCommand(argv, undefined, undefined, undefined);
  const call = runCommandWithTimeoutMock.mock.calls.at(-1);
  expect(call).toBeDefined();
  return {
    argv: call?.[0] as string[],
    options: call?.[1] as Record<string, unknown>,
  };
}

beforeEach(() => {
  runCommandWithTimeoutMock.mockReset();
  runCommandWithTimeoutMock.mockResolvedValue({
    termination: "exit",
    code: 0,
    stdout: "",
    stderr: "",
  });
  process.env.SystemRoot = "C:\\Windows";
});

afterEach(() => {
  Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
  if (originalSystemRoot === undefined) {
    delete process.env.SystemRoot;
  } else {
    process.env.SystemRoot = originalSystemRoot;
  }
  if (originalWindir === undefined) {
    delete process.env.WINDIR;
  } else {
    process.env.WINDIR = originalWindir;
  }
  vi.restoreAllMocks();
});

// These assert at the command-runner boundary rather than on a helper, so
// reverting runCommand's wiring — dropping the wrapped argv or the forwarded
// windowsVerbatimArguments option — fails them and restores the reported bug.
describe("runCommand Windows cmd quoting", () => {
  describe("canonical cmd.exe invocations reach the runner verbatim", () => {
    it.each([
      ["bare executable", "cmd.exe", SWITCHES],
      ["upper-case switches", "cmd.exe", ["/D", "/S", "/C"] as const],
      ["backslash SystemRoot path", "C:\\Windows\\System32\\cmd.exe", SWITCHES],
      ["forward-slash SystemRoot path", "C:/Windows/System32/cmd.exe", SWITCHES],
    ])("%s", async (_name, executable, switches) => {
      setPlatform("win32");
      const argv = [executable, ...switches, PAYLOAD];

      const call = await captureRunnerCall(argv);

      // The payload gains exactly one wrapping quote pair for `/s` to consume;
      // its own content is never rewritten.
      expect(call.argv).toEqual([executable, ...switches, `"${PAYLOAD}"`]);
      expect(call.options.windowsVerbatimArguments).toBe(true);
      // The caller's array must not be mutated.
      expect(argv[4]).toBe(PAYLOAD);
    });

    it("falls back to WINDIR when SystemRoot is unset", async () => {
      setPlatform("win32");
      delete process.env.SystemRoot;
      process.env.WINDIR = "D:\\Windows";

      const call = await captureRunnerCall([
        "D:\\Windows\\System32\\cmd.exe",
        ...SWITCHES,
        PAYLOAD,
      ]);

      expect(call.options.windowsVerbatimArguments).toBe(true);
    });

    it("still recognises the bare executable when the Windows root is unusable", async () => {
      setPlatform("win32");
      process.env.SystemRoot = "not-a-path";

      const call = await captureRunnerCall(["cmd.exe", ...SWITCHES, PAYLOAD]);

      expect(call.options.windowsVerbatimArguments).toBe(true);
    });

    it("preserves the remaining run options", async () => {
      setPlatform("win32");

      await testing.runCommand(["cmd.exe", ...SWITCHES, PAYLOAD], "C:\\work", { FOO: "bar" }, 1234);
      const options = runCommandWithTimeoutMock.mock.calls.at(-1)?.[1] as Record<string, unknown>;

      expect(options).toMatchObject({
        baseEnv: { FOO: "bar" },
        cwd: "C:\\work",
        killProcessTree: true,
        timeoutMs: 1234,
        windowsVerbatimArguments: true,
      });
    });
  });

  describe("everything else reaches the runner untouched", () => {
    it.each([
      ["a cmd.exe outside the Windows root", ["C:\\Other\\cmd.exe", ...SWITCHES, PAYLOAD]],
      ["powershell", ["powershell.exe", ...SWITCHES, PAYLOAD]],
      ["a direct executable", ["node.exe", "-e", "1"]],
      ["a four-element argv", ["cmd.exe", ...SWITCHES]],
      ["a six-element argv", ["cmd.exe", ...SWITCHES, PAYLOAD, "extra"]],
      ["reordered switches", ["cmd.exe", "/s", "/d", "/c", PAYLOAD]],
      ["a missing switch", ["cmd.exe", "/d", "/c", PAYLOAD, "extra"]],
    ])("leaves %s untouched", async (_name, argv) => {
      setPlatform("win32");

      const call = await captureRunnerCall(argv as string[]);

      // The exact same array instance is handed to the runner — no copy, no rewrite.
      expect(call.argv).toBe(argv);
      expect(call.options.windowsVerbatimArguments).toBeUndefined();
    });

    it("rejects an absolute cmd.exe when the Windows root is unusable", async () => {
      setPlatform("win32");
      process.env.SystemRoot = "not-a-path";
      delete process.env.WINDIR;
      const argv = ["C:\\Windows\\System32\\cmd.exe", ...SWITCHES, PAYLOAD];

      const call = await captureRunnerCall(argv);

      expect(call.argv).toBe(argv);
      expect(call.options.windowsVerbatimArguments).toBeUndefined();
    });

    it("ignores a non-string argv entry", async () => {
      setPlatform("win32");
      const argv = ["cmd.exe", ...SWITCHES, 123 as unknown as string];

      const call = await captureRunnerCall(argv);

      expect(call.argv).toBe(argv);
      expect(call.options.windowsVerbatimArguments).toBeUndefined();
    });

    it.each([["darwin"], ["linux"]])("does nothing on %s", async (platform) => {
      setPlatform(platform as NodeJS.Platform);
      const argv = ["cmd.exe", ...SWITCHES, PAYLOAD];

      const call = await captureRunnerCall(argv);

      expect(call.argv).toBe(argv);
      expect(call.options.windowsVerbatimArguments).toBeUndefined();
    });
  });
});
