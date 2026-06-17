// Covers fatal error hook registration, output collection, and the
// OPENCLAW_ERROR_HANDLER external-spawn path.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  registerFatalErrorHook,
  resetFatalErrorHooksForTest,
  runFatalErrorHooks,
} from "./fatal-error-hooks.js";

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", async () => ({
  ...(await vi.importActual<typeof import("node:child_process")>("node:child_process")),
  spawn: spawnMock,
}));

class FakeChild extends EventEmitter {
  unref = vi.fn();
}

const tempDirs: string[] = [];

async function makeHandlerScript(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "openclaw-error-handler-"));
  tempDirs.push(dir);
  const path = join(dir, "handler.sh");
  await writeFile(path, "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });
  return path;
}

interface SpawnCall {
  command: string;
  args: readonly string[];
  options: {
    env?: NodeJS.ProcessEnv;
    stdio?: "ignore" | "pipe" | "inherit" | NodeJS.StdioOptions;
    detached?: boolean;
    shell?: boolean | string;
  };
}

function firstCall(): SpawnCall {
  const call = spawnMock.mock.calls[0];
  if (!call) {
    throw new Error("Expected spawn to have been called");
  }
  const [command, args, options] = call as [string, readonly string[], SpawnCall["options"]];
  return { command, args, options };
}

function resetSpawnMock(child: FakeChild): void {
  spawnMock.mockReset();
  spawnMock.mockReturnValue(child);
}

describe("fatal error hooks", () => {
  beforeEach(() => {
    resetFatalErrorHooksForTest();
    resetSpawnMock(new FakeChild());
  });

  it("collects non-empty hook messages", () => {
    registerFatalErrorHook(() => "first");
    registerFatalErrorHook(() => "  ");
    registerFatalErrorHook(() => "second");

    expect(runFatalErrorHooks({ reason: "uncaught_exception" })).toEqual(["first", "second"]);
  });

  it("does not expose hook failure message or stack text", () => {
    registerFatalErrorHook(() => {
      throw new Error("raw secret from hook");
    });

    const messages = runFatalErrorHooks({ reason: "uncaught_exception" });
    const output = messages.join("\n");

    expect(messages).toEqual(["fatal-error hook failed: Error"]);
    expect(output).not.toContain("raw secret");
    expect(output).not.toContain("at ");
  });
});

describe("OPENCLAW_ERROR_HANDLER external spawn", () => {
  const ORIGINAL_ENV = process.env.OPENCLAW_ERROR_HANDLER;
  let originalPath: string | undefined;

  beforeEach(() => {
    resetFatalErrorHooksForTest();
    resetSpawnMock(new FakeChild());
    originalPath = process.env.PATH;
    delete process.env.OPENCLAW_ERROR_HANDLER;
  });

  afterEach(async () => {
    if (ORIGINAL_ENV === undefined) {
      delete process.env.OPENCLAW_ERROR_HANDLER;
    } else {
      process.env.OPENCLAW_ERROR_HANDLER = ORIGINAL_ENV;
    }
    if (originalPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = originalPath;
    }
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("does not spawn when OPENCLAW_ERROR_HANDLER is unset", () => {
    runFatalErrorHooks({ reason: "uncaught_exception" });
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("does not spawn when OPENCLAW_ERROR_HANDLER is the empty string", () => {
    process.env.OPENCLAW_ERROR_HANDLER = "";
    runFatalErrorHooks({ reason: "uncaught_exception" });
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("does not spawn when OPENCLAW_ERROR_HANDLER is whitespace only", () => {
    process.env.OPENCLAW_ERROR_HANDLER = "   \t  ";
    runFatalErrorHooks({ reason: "uncaught_exception" });
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("spawns the configured handler with a single JSON argv entry", async () => {
    const handlerPath = await makeHandlerScript();
    process.env.OPENCLAW_ERROR_HANDLER = handlerPath;

    runFatalErrorHooks({ reason: "unhandled_rejection" });

    expect(spawnMock).toHaveBeenCalledTimes(1);
    const call = firstCall();
    expect(call.command).toBe(handlerPath);
    expect(call.args).toHaveLength(1);

    const payload = JSON.parse(call.args[0] as string) as Record<string, unknown>;
    expect(payload.schemaVersion).toBe(1);
    expect(payload.reason).toBe("unhandled_rejection");
    expect(typeof payload.timestamp).toBe("string");
    expect(payload.timestamp as string).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(payload.pid).toBe(process.pid);
    // The redacted payload must NOT carry error name, message, or stack.
    expect(payload).not.toHaveProperty("error");
    expect(payload).not.toHaveProperty("message");
    expect(payload).not.toHaveProperty("name");
    expect(payload).not.toHaveProperty("stack");
  });

  it("uses PATH-only env, stdio:ignore, detached:true, and shell:false", async () => {
    const handlerPath = await makeHandlerScript();
    process.env.OPENCLAW_ERROR_HANDLER = handlerPath;
    process.env.PATH = "/usr/bin:/bin";
    process.env.SECRET_TOKEN = "must-not-leak";
    process.env.OPENAI_API_KEY = "sk-must-not-leak";

    runFatalErrorHooks({ reason: "uncaught_exception" });

    const { options } = firstCall();
    expect(options.env).toEqual({ PATH: "/usr/bin:/bin" });
    expect(options.env).not.toHaveProperty("SECRET_TOKEN");
    expect(options.env).not.toHaveProperty("OPENAI_API_KEY");
    expect(options.stdio).toBe("ignore");
    expect(options.detached).toBe(true);
    expect(options.shell).toBe(false);
  });

  it("unrefs the child so OpenClaw does not wait on the handler", async () => {
    const child = new FakeChild();
    resetSpawnMock(child);
    const handlerPath = await makeHandlerScript();
    process.env.OPENCLAW_ERROR_HANDLER = handlerPath;

    runFatalErrorHooks({ reason: "uncaught_exception" });

    expect(child.unref).toHaveBeenCalledTimes(1);
  });

  it("attaches an error listener and unrefs so spawn failures do not propagate", () => {
    const child = new FakeChild();
    const onSpy = vi.spyOn(child, "on");
    resetSpawnMock(child);
    process.env.OPENCLAW_ERROR_HANDLER = "/nonexistent/handler";

    // Should not throw — the outer try/catch covers sync spawn throws, and
    // the registered "error" listener swallows async spawn failures.
    expect(() => runFatalErrorHooks({ reason: "uncaught_exception" })).not.toThrow();
    expect(onSpy).toHaveBeenCalledWith("error", expect.any(Function));
    expect(child.unref).toHaveBeenCalledTimes(1);
  });
});
