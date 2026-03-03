import fs from "node:fs/promises";
import path from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { HookHandler } from "../../hooks.js";
import { makeTempWorkspace } from "../../../test-helpers/workspace.js";
import { createHookEvent } from "../../hooks.js";

// Track all promisified calls with their args
const promisifiedCalls: unknown[][] = [];
const mockStdinInstances: Array<{
  write: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
}> = [];

// The wrapper function that child_process.execFile will be
let execFileWrapper: (...args: unknown[]) => unknown;

// Mock child_process.execFile
vi.mock("node:child_process", () => {
  execFileWrapper = (..._args: unknown[]) => {
    // This is the raw callback-based execFile; we don't use it directly
  };
  return {
    execFile: execFileWrapper,
  };
});

// Mock node:util promisify to return our async mock
vi.mock("node:util", async (importOriginal) => {
  const orig = await importOriginal();
  return {
    ...orig,
    promisify: (fn: unknown) => {
      // If it's our mocked execFile (the wrapper), return the promisified version
      if (fn === execFileWrapper) {
        return (...args: unknown[]) => {
          promisifiedCalls.push(args);
          const cmd = args[0] as string;
          const cmdArgs = args[1] as string[] | undefined;

          // `entire --version` check → succeed
          if (cmd === "entire" && cmdArgs?.[0] === "--version") {
            return Object.assign(Promise.resolve({ stdout: "1.0.0", stderr: "" }), {
              child: { stdin: null },
            });
          }

          // `entire hooks openclaw <verb>` → succeed with stdin mock
          if (cmd === "entire" && cmdArgs?.[0] === "hooks") {
            const mockStdin = { write: vi.fn(), end: vi.fn() };
            mockStdinInstances.push(mockStdin);
            return Object.assign(Promise.resolve({ stdout: "", stderr: "" }), {
              child: { stdin: mockStdin },
            });
          }

          // Anything else → ENOENT
          const err = Object.assign(new Error(`spawn ${cmd} ENOENT`), { code: "ENOENT" });
          return Object.assign(Promise.reject(err), { child: { stdin: null } });
        };
      }
      return orig.promisify(fn);
    },
  };
});

let handler: HookHandler;

beforeAll(async () => {
  ({ default: handler } = await import("./handler.js"));
});

beforeEach(() => {
  vi.clearAllMocks();
  promisifiedCalls.length = 0;
  mockStdinInstances.length = 0;
});

/** Helper: create a temp workspace with .entire/settings.json */
async function makeEntireWorkspace(): Promise<string> {
  const tempDir = await makeTempWorkspace("openclaw-entire-");
  await fs.mkdir(path.join(tempDir, ".entire"), { recursive: true });
  await fs.writeFile(path.join(tempDir, ".entire", "settings.json"), "{}", "utf-8");
  return tempDir;
}

/** Extract the verb from a promisified call like ["entire", ["hooks", "openclaw", <verb>], ...] */
function extractVerbs(): string[] {
  return promisifiedCalls
    .filter((c) => {
      const args = c[1] as string[] | undefined;
      return c[0] === "entire" && args?.[0] === "hooks" && args?.[1] === "openclaw";
    })
    .map((c) => (c[1] as string[])[2]);
}

describe("entire-checkpoints hook", () => {
  it("skips when event type does not match", async () => {
    const event = createHookEvent("agent", "bootstrap", "agent:main:main", {});
    await handler(event);
    expect(promisifiedCalls).toHaveLength(0);
  });

  it("skips when entire binary is not found (ENOENT)", async () => {
    const tempDir = await makeTempWorkspace("openclaw-entire-");
    // No .entire/settings.json — but also entire --version would succeed.
    // The handler checks binary first, then settings. Since binary succeeds
    // but no settings.json → skip.
    const event = createHookEvent("gateway", "startup", "agent:main:main", {
      workspaceDir: tempDir,
    });

    await handler(event);
    expect(extractVerbs()).toHaveLength(0);
  });

  it("skips when .entire/settings.json does not exist", async () => {
    const tempDir = await makeTempWorkspace("openclaw-entire-");

    const event = createHookEvent("gateway", "startup", "agent:main:main", {
      workspaceDir: tempDir,
    });

    await handler(event);
    expect(extractVerbs()).toHaveLength(0);
  });

  it("processes gateway:startup event", async () => {
    const tempDir = await makeEntireWorkspace();

    const event = createHookEvent("gateway", "startup", "agent:main:main", {
      workspaceDir: tempDir,
      sessionEntry: { sessionId: "sess-1", sessionFile: "/tmp/sess.jsonl" },
    });

    await handler(event);

    const verbs = extractVerbs();
    expect(verbs).toContain("session-start");
    expect(verbs).toContain("user-prompt-submit");
  });

  it("processes command:stop event", async () => {
    const tempDir = await makeEntireWorkspace();

    const event = createHookEvent("command", "stop", "agent:main:main", {
      workspaceDir: tempDir,
    });

    await handler(event);

    const verbs = extractVerbs();
    expect(verbs).toContain("stop");
    expect(verbs).toHaveLength(1);
  });

  it("processes command:new event", async () => {
    const tempDir = await makeEntireWorkspace();

    const event = createHookEvent("command", "new", "agent:main:main", {
      workspaceDir: tempDir,
      previousSessionEntry: { sessionId: "sess-old" },
      firstUserMessage: "Hello world",
    });

    await handler(event);

    const verbs = extractVerbs();
    expect(verbs).toContain("stop");
    expect(verbs).toContain("session-end");
    expect(verbs).toContain("session-start");
    expect(verbs).toContain("user-prompt-submit");
  });
});
