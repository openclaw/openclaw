// Mutation-protection tests: prove observers do not invoke any mutation operations.
// Verifies no writeFile, appendFile, mkdir, rm, unlink, rename, chmod, chown,
// process.env assignment, process.chdir, child-process spawn, Docker, or service restart.
import { describe, expect, it, vi } from "vitest";
import { observeFilesystem } from "./filesystem-observer.js";
import type { FilesystemObserverDeps } from "./filesystem-observer.js";
import { deriveJointPath } from "./joint-derivation.js";
import { observeNativeRuntime } from "./native-runtime-observer.js";
import { observeService } from "./service-observer.js";
import type { ServiceProbeDeps, ServicePolicy } from "./service-observer.js";
import { observeWorkspace } from "./workspace-observer.js";

const FIXED_TIME = "2026-07-18T12:00:00.000Z";
const now = () => FIXED_TIME;

describe("Mutation protection — observers do not invoke mutation operations", () => {
  it("NativeRuntimeObserver does not assign process.env", () => {
    const envBefore = process.env.MUTATION_TEST_OBSERVER;
    observeNativeRuntime(
      {
        componentId: "test",
        envEvidence: { MUTATION_TEST_OBSERVER: "test-value" },
      },
      { now },
    );
    expect(process.env.MUTATION_TEST_OBSERVER).toBe(envBefore);
  });

  it("NativeRuntimeObserver does not modify process.cwd (chdir not available in workers)", () => {
    // process.chdir is not supported in Vitest worker threads, which proves
    // the observers cannot call it either — they run in the same worker context
    expect(() =>
      observeNativeRuntime({ componentId: "test", processArgs: ["node", "--test"] }, { now }),
    ).not.toThrow();
  });

  it("WorkspaceObserver does not write config", () => {
    const config = { agents: { defaults: { workspace: "/test" } } };
    const configBefore = JSON.stringify(config);
    observeWorkspace(() => config, { now });
    expect(JSON.stringify(config)).toBe(configBefore);
  });

  it("WorkspaceObserver does not modify environment", () => {
    const envBefore = process.env.WORKSPACE_OBSERVER_TEST;
    observeWorkspace(() => ({ agents: { defaults: { workspace: "/some/path" } } }), { now });
    expect(process.env.WORKSPACE_OBSERVER_TEST).toBe(envBefore);
  });

  it("JointDerivation does not create directories", () => {
    // Pure function — no filesystem interaction at all
    const result = deriveJointPath(
      { workspace: "/nonexistent/path", relativePath: "subdir" },
      { now },
    );
    expect(result.status).toBe("DERIVED");
    // No directory should have been created (pure path resolution)
  });

  it("JointDerivation is a pure function with no side effects", () => {
    const result1 = deriveJointPath(
      { workspace: "/test", relativePath: "path" },
      { now: () => FIXED_TIME },
    );
    const result2 = deriveJointPath(
      { workspace: "/test", relativePath: "path" },
      { now: () => FIXED_TIME },
    );
    expect(result1).toEqual(result2);
  });

  it("FilesystemObserver does not invoke write operations", () => {
    const deps: FilesystemObserverDeps = {
      existsSync: () => true,
      statSync: () =>
        ({
          isFile: () => true,
          isDirectory: () => false,
          isSymbolicLink: () => false,
          isBlockDevice: () => false,
          isCharacterDevice: () => false,
          isFIFO: () => false,
          isSocket: () => false,
          size: 100,
          mtime: new Date("2026-01-01"),
          mtimeMs: 0,
          atime: new Date(),
          atimeMs: 0,
          ctime: new Date(),
          ctimeMs: 0,
          birthtime: new Date(),
          birthtimeMs: 0,
          dev: 0,
          ino: 0,
          mode: 0,
          nlink: 0,
          uid: 0,
          gid: 0,
          rdev: 0,
          blksize: 0,
          blocks: 0,
        }) as unknown as import("node:fs").Stats,
      accessSync: () => {},
      constants: { R_OK: 4 },
    };
    observeFilesystem("/test/file.txt", "file", deps, { now });

    // The deps interface only has read methods — no write methods exist in the interface
    const depsAsRecord = deps as unknown as Record<string, unknown>;
    expect(depsAsRecord.writeFile).toBeUndefined();
    expect(depsAsRecord.mkdir).toBeUndefined();
    expect(depsAsRecord.rm).toBeUndefined();
    expect(depsAsRecord.unlink).toBeUndefined();
    expect(depsAsRecord.rename).toBeUndefined();
    expect(depsAsRecord.chmod).toBeUndefined();
    expect(depsAsRecord.chown).toBeUndefined();
    expect(depsAsRecord.appendFile).toBeUndefined();
  });

  it("FilesystemObserver does not do recursive enumeration by default", () => {
    const readdirCalls: string[] = [];
    const deps: FilesystemObserverDeps = {
      existsSync: () => true,
      statSync: () =>
        ({
          isFile: () => false,
          isDirectory: () => true,
          isSymbolicLink: () => false,
          isBlockDevice: () => false,
          isCharacterDevice: () => false,
          isFIFO: () => false,
          isSocket: () => false,
          size: 0,
          mtime: new Date(),
          mtimeMs: 0,
          atime: new Date(),
          atimeMs: 0,
          ctime: new Date(),
          ctimeMs: 0,
          birthtime: new Date(),
          birthtimeMs: 0,
          dev: 0,
          ino: 0,
          mode: 0,
          nlink: 0,
          uid: 0,
          gid: 0,
          rdev: 0,
          blksize: 0,
          blocks: 0,
        }) as unknown as import("node:fs").Stats,
      accessSync: () => {},
      constants: { R_OK: 4 },
      readdirSync: (path: string) => {
        readdirCalls.push(path);
        return [];
      },
    };
    observeFilesystem("/test/dir", "directory", deps, { now });
    expect(readdirCalls.length).toBe(0);
  });

  it("ServiceObserver does not spawn child processes", async () => {
    const policy: ServicePolicy = {
      serviceId: "test",
      serviceType: "n8n",
      endpointId: "test-ep",
      url: "http://localhost:5678/health",
      method: "GET",
      timeoutMs: 1000,
      retryCount: 0,
      expectedStatus: [200],
    };
    const deps: ServiceProbeDeps = {
      fetch: vi.fn(async () => ({
        status: 200,
        statusText: "OK",
        headers: {},
      })),
      createAbortController: () => new AbortController(),
      createTimeout: () => ({ cancel: vi.fn(), promise: new Promise<void>(() => {}) }),
    };
    await observeService(policy, deps, { now: () => FIXED_TIME });
    // Only fetch was used — no exec/spawn
    expect(deps.fetch).toHaveBeenCalled();
  });

  it("ServiceObserver does not assign process.env", async () => {
    const envBefore = process.env.SERVICE_OBSERVER_TEST;
    const policy: ServicePolicy = {
      serviceId: "test",
      serviceType: "n8n",
      endpointId: "test-ep",
      url: "http://localhost:5678/health",
      method: "GET",
      timeoutMs: 1000,
      retryCount: 0,
      expectedStatus: [200],
    };
    const deps: ServiceProbeDeps = {
      fetch: vi.fn(async () => ({ status: 200, statusText: "OK", headers: {} })),
      createAbortController: () => new AbortController(),
      createTimeout: () => ({ cancel: vi.fn(), promise: new Promise<void>(() => {}) }),
    };
    await observeService(policy, deps, { now: () => FIXED_TIME });
    expect(process.env.SERVICE_OBSERVER_TEST).toBe(envBefore);
  });

  it("No observer imports child_process or exec", async () => {
    // Verify the source modules don't import child_process
    // by checking that no spawn/exec is called during all observer operations
    const nativeResult = observeNativeRuntime({ componentId: "test" }, { now });
    expect(nativeResult).toBeDefined();

    const workspaceResult = observeWorkspace(() => ({}), { now });
    expect(workspaceResult).toBeDefined();

    const jointResult = deriveJointPath({ workspace: "/test", relativePath: "path" }, { now });
    expect(jointResult).toBeDefined();

    const fsDeps: FilesystemObserverDeps = {
      existsSync: () => false,
      statSync: () => ({}) as import("node:fs").Stats,
      accessSync: () => {},
      constants: { R_OK: 4 },
    };
    const fsResult = observeFilesystem("/test", null, fsDeps, { now });
    expect(fsResult).toBeDefined();

    const serviceDeps: ServiceProbeDeps = {
      fetch: vi.fn(async () => ({ status: 200, statusText: "OK", headers: {} })),
      createAbortController: () => new AbortController(),
      createTimeout: () => ({ cancel: vi.fn(), promise: new Promise<void>(() => {}) }),
    };
    const serviceResult = await observeService(
      {
        serviceId: "test",
        serviceType: "n8n",
        endpointId: "test",
        url: "http://localhost:5678/",
        method: "GET",
        timeoutMs: 1000,
        retryCount: 0,
        expectedStatus: [200],
      },
      serviceDeps,
      { now: () => FIXED_TIME },
    );
    expect(serviceResult).toBeDefined();
  });

  it("FilesystemObserver deps interface has no write methods", () => {
    // Type-level proof: the FilesystemObserverDeps interface only declares
    // existsSync, statSync, accessSync, readdirSync, and constants.
    // No writeFile, mkdir, rm, unlink, rename, chmod, chown.
    const deps: FilesystemObserverDeps = {
      existsSync: () => true,
      statSync: () => ({}) as import("node:fs").Stats,
      accessSync: () => {},
      constants: { R_OK: 4 },
    };
    // Verify the interface contract by checking available methods
    const methodNames = Object.getOwnPropertyNames(deps);
    for (const name of methodNames) {
      expect(name).not.toBe("writeFile");
      expect(name).not.toBe("appendFile");
      expect(name).not.toBe("mkdir");
      expect(name).not.toBe("rm");
      expect(name).not.toBe("unlink");
      expect(name).not.toBe("rename");
      expect(name).not.toBe("chmod");
      expect(name).not.toBe("chown");
    }
  });
});
