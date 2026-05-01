import path from "node:path";
import { importFreshModule } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, describe, expect, it, vi } from "vitest";

// Capture the warn fn before module mocking so we can inspect calls.
const warn = vi.hoisted(() => vi.fn());

vi.mock("../../logging/subsystem.js", () => ({
  createSubsystemLogger: vi.fn(() => ({
    warn,
    debug: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    raw: vi.fn(),
    child: vi.fn(),
    subsystem: "channels",
    isEnabled: vi.fn(() => false),
  })),
}));

vi.mock("../../plugins/bundled-dir.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../plugins/bundled-dir.js")>();
  return {
    ...actual,
    resolveBundledPluginsDir: (env: NodeJS.ProcessEnv = process.env) =>
      env.OPENCLAW_BUNDLED_PLUGINS_DIR ?? actual.resolveBundledPluginsDir(env),
  };
});

const originalBundledPluginsDir = process.env.OPENCLAW_BUNDLED_PLUGINS_DIR;

afterEach(() => {
  warn.mockClear();
  if (originalBundledPluginsDir === undefined) {
    delete process.env.OPENCLAW_BUNDLED_PLUGINS_DIR;
  } else {
    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = originalBundledPluginsDir;
  }
  vi.resetModules();
  vi.doUnmock("../../plugins/bundled-channel-runtime.js");
  vi.doUnmock("./module-loader.js");
});

const FAKE_LOCK_DIR = "/tmp/openclaw-stage/.openclaw-runtime-deps.lock";

const LOCK_TIMEOUT_MESSAGE =
  `Timed out waiting for bundled runtime deps lock at ${FAKE_LOCK_DIR} ` +
  `(waited=300000ms, ownerFile=present, ownerFileSymlink=false, pid=12345 alive=false, ` +
  `ownerAge=300001ms, ownerFileAge=300001ms, lockAge=300001ms, ` +
  `ownerFilePath=${FAKE_LOCK_DIR}/owner.json). ` +
  `If no OpenClaw/npm install is running, remove the lock directory and retry.`;

const ALPHA_METADATA = {
  dirName: "alpha",
  manifest: {
    id: "alpha",
    channels: ["alpha"],
  },
  source: {
    source: "./index.js",
    built: "./index.js",
  },
};

function mockBundledChannelRuntime(modulePath: string) {
  vi.doMock("../../plugins/bundled-channel-runtime.js", () => ({
    listBundledChannelPluginMetadata: () => [ALPHA_METADATA],
    resolveBundledChannelGeneratedPath: () => modulePath,
  }));
}

describe("loadGeneratedBundledChannelEntry: structured warn for lock timeout", () => {
  it("emits structured warn with failureReason=lock_timeout when a lock timeout error is thrown", async () => {
    const fakeModulePath = path.join("/tmp", "openclaw-alpha", "index.js");

    mockBundledChannelRuntime(fakeModulePath);

    // Mock loadChannelPluginModule to throw a lock timeout error directly.
    // This bypasses file-system checks while exercising the catch branch in bundled.ts.
    vi.doMock("./module-loader.js", () => ({
      isJavaScriptModulePath: () => false,
      loadChannelPluginModule: () => {
        throw new Error(LOCK_TIMEOUT_MESSAGE);
      },
    }));

    const bundled = await importFreshModule<typeof import("./bundled.js")>(
      import.meta.url,
      "./bundled.js?scope=lock-timeout-structured-warn",
    );

    // getBundledChannelPlugin internally calls loadGeneratedBundledChannelEntry.
    const result = bundled.getBundledChannelPlugin("alpha");

    expect(result).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    const [message, meta] = warn.mock.calls[0] as [string, Record<string, unknown>];
    // The message preserves the upstream lock-timeout detail so pretty/compact
    // console renderers (which drop structured meta) still see the diagnostic.
    expect(message).toContain("failed to load bundled channel alpha");
    expect(message).toContain("Timed out waiting for bundled runtime deps lock at");
    expect(message).toContain(FAKE_LOCK_DIR);
    expect(message).toContain("waited=300000ms");
    expect(message).toContain("remove the lock directory and retry");
    expect(meta).toMatchObject({
      failureReason: "lock_timeout",
      bundledChannelId: "alpha",
      lockDir: FAKE_LOCK_DIR,
      waitedMs: 300000,
    });
  });

  it("preserves lockDir for paths that contain ` (` segments", async () => {
    const fakeModulePath = path.join("/tmp", "openclaw-alpha", "index.js");
    const lockDirWithParen = "/tmp/OpenClaw (prod)/.openclaw-runtime-deps.lock";
    const messageWithParen =
      `Timed out waiting for bundled runtime deps lock at ${lockDirWithParen} ` +
      `(waited=300000ms, ownerFile=present, ownerFileSymlink=false, pid=12345 alive=false, ` +
      `ownerAge=300001ms, ownerFileAge=300001ms, lockAge=300001ms, ` +
      `ownerFilePath=${lockDirWithParen}/owner.json). ` +
      `If no OpenClaw/npm install is running, remove the lock directory and retry.`;

    mockBundledChannelRuntime(fakeModulePath);
    vi.doMock("./module-loader.js", () => ({
      isJavaScriptModulePath: () => false,
      loadChannelPluginModule: () => {
        throw new Error(messageWithParen);
      },
    }));

    const bundled = await importFreshModule<typeof import("./bundled.js")>(
      import.meta.url,
      "./bundled.js?scope=lock-timeout-paren-path",
    );

    const result = bundled.getBundledChannelPlugin("alpha");

    expect(result).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    const [, meta] = warn.mock.calls[0] as [string, Record<string, unknown>];
    expect(meta).toMatchObject({
      failureReason: "lock_timeout",
      bundledChannelId: "alpha",
      lockDir: lockDirWithParen,
      waitedMs: 300000,
    });
  });

  it("emits flat string warn for non-lock-timeout module import errors", async () => {
    const fakeModulePath = path.join("/tmp", "openclaw-alpha", "index.js");

    mockBundledChannelRuntime(fakeModulePath);

    // Mock loadChannelPluginModule to throw a regular module-not-found error.
    vi.doMock("./module-loader.js", () => ({
      isJavaScriptModulePath: () => false,
      loadChannelPluginModule: () => {
        throw new Error("Cannot find module 'nostr-tools'");
      },
    }));

    const bundled = await importFreshModule<typeof import("./bundled.js")>(
      import.meta.url,
      "./bundled.js?scope=import-error-flat-warn",
    );

    const result = bundled.getBundledChannelPlugin("alpha");

    expect(result).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    // Flat string warn — no structured meta object as second argument.
    const [message, meta] = warn.mock.calls[0] as [string, unknown];
    expect(message).toContain("failed to load bundled channel alpha");
    expect(message).toContain("nostr-tools");
    expect(meta).toBeUndefined();
  });
});
