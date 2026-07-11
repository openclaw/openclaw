// Covers update status, dependency status, and registry fetch helpers.
import fs from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCommandWithTimeout } from "../process/exec.js";
import { withTempDir } from "../test-helpers/temp-dir.js";
import {
  checkDepsStatus,
  checkUpdateStatus,
  compareSemverStrings,
  fetchNpmLatestVersion,
  fetchNpmPackageTargetStatus,
  fetchNpmRegistryVersionForChannel,
  fetchNpmTagVersion,
  formatGitInstallLabel,
  resolveExtendedStablePackage,
  resolveNpmChannelTag,
} from "./update-check.js";

describe("compareSemverStrings", () => {
  it("handles stable and prerelease precedence for both legacy and beta formats", () => {
    expect(compareSemverStrings("1.0.0", "1.0.0")).toBe(0);
    expect(compareSemverStrings("v1.0.0", "1.0.0")).toBe(0);

    expect(compareSemverStrings("1.0.0", "1.0.0-beta.1")).toBe(1);
    expect(compareSemverStrings("1.0.0-beta.2", "1.0.0-beta.1")).toBe(1);

    expect(compareSemverStrings("1.0.0-2", "1.0.0-1")).toBe(1);
    expect(compareSemverStrings("1.0.0-1", "1.0.0-beta.1")).toBe(-1);
    expect(compareSemverStrings("1.0.0.beta.2", "1.0.0-beta.1")).toBe(1);
    expect(compareSemverStrings("1.0.0", "1.0.0.beta.1")).toBe(1);
  });

  it("treats OpenClaw stable correction releases as newer than their base release", () => {
    expect(compareSemverStrings("2026.5.3", "2026.5.3-1")).toBe(-1);
    expect(compareSemverStrings("2026.5.3-1", "2026.5.3")).toBe(1);
    expect(compareSemverStrings("2026.5.3-2", "2026.5.3-1")).toBe(1);
  });

  it("returns null for invalid inputs", () => {
    expect(compareSemverStrings("1.0", "1.0.0")).toBeNull();
    expect(compareSemverStrings("latest", "1.0.0")).toBeNull();
  });
});

describe("resolveNpmChannelTag", () => {
  type NpmMetadataCommandRunner = NonNullable<
    Parameters<typeof fetchNpmPackageTargetStatus>[0]["runCommand"]
  >;

  let versionByTag: Record<string, string | null>;
  let runCommand: NpmMetadataCommandRunner;
  let runCommandMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    versionByTag = {};
    runCommandMock = vi.fn(async (argv: string[]) => {
      const spec = argv[2] ?? "";
      const tag = spec.slice(spec.lastIndexOf("@") + 1);
      const version = versionByTag[tag] ?? null;
      return {
        stdout:
          version == null
            ? ""
            : JSON.stringify({
                version,
                "engines.node": ">=22.19.0",
              }),
        stderr: version == null ? "npm ERR! 404 Not Found" : "",
        code: version == null ? 1 : 0,
      };
    });
    runCommand = runCommandMock as unknown as NpmMetadataCommandRunner;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("delegates package target metadata to npm view with global config scope", async () => {
    versionByTag.latest = "1.0.4";
    const env = { ...process.env, NPM_CONFIG_USERCONFIG: "/tmp/openclaw-user-npmrc" };

    await expect(
      fetchNpmPackageTargetStatus({
        target: "latest",
        spec: "openclaw@latest",
        command: "/opt/openclaw/node/bin/npm",
        timeoutMs: 1000,
        cwd: "/tmp/openclaw-project",
        env,
        runCommand,
      }),
    ).resolves.toEqual({
      target: "latest",
      version: "1.0.4",
      nodeEngine: ">=22.19.0",
    });

    expect(runCommandMock).toHaveBeenCalledWith(
      [
        "/opt/openclaw/node/bin/npm",
        "view",
        "openclaw@latest",
        "version",
        "engines.node",
        "--json",
        "--global",
      ],
      expect.objectContaining({
        timeoutMs: 1000,
        cwd: "/tmp/openclaw-project",
        env,
      }),
    );
  });

  it("uses npm global scope, user config auth, and ignores project npmrc for real metadata", async () => {
    await withTempDir({ prefix: "openclaw-update-check-npm-view-" }, async (base) => {
      const requests: Array<{ url: string; authorization?: string }> = [];
      const server = http.createServer((req, res) => {
        requests.push({
          url: req.url ?? "",
          authorization: req.headers.authorization,
        });
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            name: "openclaw",
            "dist-tags": { latest: "2026.6.6" },
            versions: {
              "2026.6.6": {
                name: "openclaw",
                version: "2026.6.6",
                engines: { node: ">=22.19.0" },
                dist: {
                  tarball: "http://example.invalid/openclaw-2026.6.6.tgz",
                  shasum: "0".repeat(40),
                },
              },
            },
          }),
        );
      });

      await new Promise<void>((resolve) => {
        server.listen(0, "127.0.0.1", resolve);
      });
      try {
        const address = server.address() as AddressInfo;
        const registry = `http://127.0.0.1:${address.port}/user/`;
        const project = path.join(base, "project");
        const home = path.join(base, "home");
        const userConfig = path.join(home, ".npmrc");
        await fs.mkdir(project, { recursive: true });
        await fs.mkdir(home, { recursive: true });
        await fs.writeFile(path.join(project, ".npmrc"), "registry=http://127.0.0.1:9/project/\n");
        await fs.writeFile(
          userConfig,
          [`registry=${registry}`, `//127.0.0.1:${address.port}/user/:_authToken=test-token`].join(
            "\n",
          ),
        );

        await expect(
          fetchNpmPackageTargetStatus({
            target: "latest",
            command: "npm",
            timeoutMs: 10_000,
            cwd: project,
            env: {
              ...process.env,
              HOME: home,
              NPM_CONFIG_USERCONFIG: userConfig,
            },
          }),
        ).resolves.toEqual({
          target: "latest",
          version: "2026.6.6",
          nodeEngine: ">=22.19.0",
        });

        expect(requests.some((request) => request.url.startsWith("/user/openclaw"))).toBe(true);
        expect(requests.some((request) => request.url.startsWith("/project/"))).toBe(false);
        expect(requests.some((request) => request.authorization === "Bearer test-token")).toBe(
          true,
        );
      } finally {
        await new Promise<void>((resolve, reject) => {
          server.close((err) => (err ? reject(err) : resolve()));
        });
      }
    });
  });

  it("uses the public registry when no npm command is available", async () => {
    const fetch = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          version: "2026.6.8",
          engines: { node: ">=22.19.0" },
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    });
    vi.stubGlobal("fetch", fetch);

    await expect(
      fetchNpmPackageTargetStatus({ target: "latest", timeoutMs: 1000 }),
    ).resolves.toEqual({
      target: "latest",
      version: "2026.6.8",
      nodeEngine: ">=22.19.0",
    });
    expect(fetch).toHaveBeenCalledWith(
      "https://registry.npmjs.org/openclaw/latest",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("cancels public registry HTTP failure bodies", async () => {
    const cancel = vi.fn(async () => undefined);
    const fetch = vi.fn(
      async () => ({ ok: false, status: 503, body: { cancel } }) as unknown as Response,
    );
    vi.stubGlobal("fetch", fetch);

    await expect(
      fetchNpmPackageTargetStatus({ target: "latest", timeoutMs: 1000 }),
    ).resolves.toEqual({
      target: "latest",
      version: null,
      nodeEngine: null,
      error: "HTTP 503",
    });
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("returns error on oversized public registry response exceeding 16 MiB", async () => {
    const ONE_MIB = 1024 * 1024;
    const fetch = vi.fn(async () => {
      const oversizedBody = new Uint8Array(16 * ONE_MIB + 1).fill(0x41);
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(oversizedBody);
            controller.close();
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetch);

    const result = await fetchNpmPackageTargetStatus({ target: "latest", timeoutMs: 5000 });
    expect(result.version).toBeNull();
    expect(result.nodeEngine).toBeNull();
    expect(result.error).toContain("JSON response exceeds");
    expect(result.error).toContain("16777216");
  });

  it("parses a valid public registry response just under 16 MiB", async () => {
    const targetSize = 16 * 1024 * 1024 - 1024; // just under 16 MiB
    const innerLen = targetSize - 14; // '{"version":"'.length(12) + '"}"'.length(2)
    const body = `{"version":"${"0".repeat(innerLen)}"}`;

    const fetch = vi.fn(async () => {
      return new Response(body, {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetch);

    const result = await fetchNpmPackageTargetStatus({ target: "latest", timeoutMs: 5000 });
    // The version field is a giant string — it exists, confirming parse succeeded
    expect(result.version).toContain("0");
    expect(result.nodeEngine).toBeNull();
    expect(result.error).toBeUndefined();
  });

  it("returns error on malformed JSON from registry", async () => {
    const fetch = vi.fn(async () => {
      return new Response("not-json-at-all{{{", {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetch);

    const result = await fetchNpmPackageTargetStatus({ target: "latest", timeoutMs: 1000 });
    expect(result.version).toBeNull();
    expect(result.error).toContain("malformed JSON");
  });

  it("returns error on non-200 status from registry", async () => {
    const fetch = vi.fn(async () => {
      return new Response(null, {
        status: 404,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetch);

    const result = await fetchNpmPackageTargetStatus({ target: "latest", timeoutMs: 1000 });
    expect(result.version).toBeNull();
    expect(result.error).toBe("HTTP 404");
  });

  it("falls back to latest when beta is older", async () => {
    versionByTag.beta = "1.0.0-beta.1";
    versionByTag.latest = "1.0.1-1";

    const resolved = await resolveNpmChannelTag({ channel: "beta", timeoutMs: 1000, runCommand });

    expect(resolved).toEqual({ tag: "latest", version: "1.0.1-1" });
  });

  it("keeps beta when beta is not older", async () => {
    versionByTag.beta = "1.0.2-beta.1";
    versionByTag.latest = "1.0.1-1";

    const resolved = await resolveNpmChannelTag({ channel: "beta", timeoutMs: 1000, runCommand });

    expect(resolved).toEqual({ tag: "beta", version: "1.0.2-beta.1" });
  });

  it("falls back to latest when beta has same base as stable", async () => {
    versionByTag.beta = "1.0.1-beta.2";
    versionByTag.latest = "1.0.1";

    const resolved = await resolveNpmChannelTag({ channel: "beta", timeoutMs: 1000, runCommand });

    expect(resolved).toEqual({ tag: "latest", version: "1.0.1" });
  });

  it("keeps non-beta channels unchanged", async () => {
    versionByTag.latest = "1.0.3";

    await expect(
      resolveNpmChannelTag({ channel: "stable", timeoutMs: 1000, runCommand }),
    ).resolves.toEqual({
      tag: "latest",
      version: "1.0.3",
    });
  });

  it("exposes tag fetch helpers for success and http failures", async () => {
    versionByTag.latest = "1.0.4";

    await expect(
      fetchNpmPackageTargetStatus({ target: "latest", timeoutMs: 1000, runCommand }),
    ).resolves.toEqual({
      target: "latest",
      version: "1.0.4",
      nodeEngine: ">=22.19.0",
    });
    await expect(
      fetchNpmTagVersion({ tag: "latest", timeoutMs: 1000, runCommand }),
    ).resolves.toEqual({
      tag: "latest",
      version: "1.0.4",
    });
    await expect(fetchNpmLatestVersion({ timeoutMs: 1000, runCommand })).resolves.toEqual({
      latestVersion: "1.0.4",
      error: undefined,
    });
    versionByTag.beta = "1.0.5-beta.1";
    await expect(
      fetchNpmRegistryVersionForChannel({ channel: "beta", timeoutMs: 1000, runCommand }),
    ).resolves.toEqual({
      latestVersion: "1.0.5-beta.1",
      tag: "beta",
    });
    await expect(fetchNpmTagVersion({ tag: "beta", timeoutMs: 1000, runCommand })).resolves.toEqual(
      {
        tag: "beta",
        version: "1.0.5-beta.1",
        error: undefined,
      },
    );
    await expect(
      fetchNpmTagVersion({ tag: "missing", timeoutMs: 1000, runCommand }),
    ).resolves.toEqual({
      tag: "missing",
      version: null,
      error: "npm view failed: npm ERR! 404 Not Found",
    });
  });

  it("adds context to malformed npm view JSON errors", async () => {
    const badRunCommand = vi.fn(async () => ({
      stdout: "not valid json {",
      stderr: "",
      code: 0,
    }));

    const result = await fetchNpmPackageTargetStatus({
      target: "openclaw",
      timeoutMs: 1000,
      runCommand: badRunCommand as unknown as typeof runCommandWithTimeout,
    });

    expect(result.version).toBeNull();
    expect(result.nodeEngine).toBeNull();
    expect(result.error).toContain("npm view returned invalid JSON");
    expect(result.error).toContain("SyntaxError");
  });
});

describe("resolveExtendedStablePackage", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("resolves and verifies an exact public package without falling back", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ version: "2026.6.33" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ version: "2026.6.33" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    vi.stubGlobal("fetch", fetch);

    await expect(
      resolveExtendedStablePackage({ installKind: "package", timeoutMs: 1000, env: {} }),
    ).resolves.toEqual({
      status: "resolved",
      selector: "extended-stable",
      version: "2026.6.33",
      packageSpec: "openclaw@2026.6.33",
    });
    expect(fetch.mock.calls.map((call) => call[0])).toEqual([
      "https://registry.npmjs.org/openclaw/extended-stable",
      "https://registry.npmjs.org/openclaw/2026.6.33",
    ]);
  });

  it("supports an explicit scoped-package override on a loopback test registry", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ version: "2000.4.34" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ version: "2000.4.34" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    vi.stubGlobal("fetch", fetch);

    await expect(
      resolveExtendedStablePackage({
        installKind: "package",
        timeoutMs: 1000,
        packageName: "@kevins8/openclaw",
        env: {
          OPENCLAW_UPDATE_PACKAGE_SPEC: "@kevins8/openclaw",
          NPM_CONFIG_REGISTRY: "http://127.0.0.1:4873/",
        },
      }),
    ).resolves.toEqual({
      status: "resolved",
      selector: "extended-stable",
      version: "2000.4.34",
      packageSpec: "@kevins8/openclaw@2000.4.34",
    });
    expect(fetch.mock.calls.map((call) => call[0])).toEqual([
      "http://127.0.0.1:4873/%40kevins8%2Fopenclaw/extended-stable",
      "http://127.0.0.1:4873/%40kevins8%2Fopenclaw/2000.4.34",
    ]);
  });

  it("ignores package overrides that do not use a loopback registry", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ version: "2026.6.33" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ version: "2026.6.33" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    vi.stubGlobal("fetch", fetch);

    await expect(
      resolveExtendedStablePackage({
        installKind: "package",
        timeoutMs: 1000,
        packageName: "@kevins8/openclaw",
        env: {
          OPENCLAW_UPDATE_PACKAGE_SPEC: "@kevins8/openclaw",
          NPM_CONFIG_REGISTRY: "https://registry.example.com/",
        },
      }),
    ).resolves.toMatchObject({
      status: "resolved",
      packageSpec: "openclaw@2026.6.33",
    });
    expect(fetch.mock.calls.map((call) => call[0])).toEqual([
      "https://registry.npmjs.org/openclaw/extended-stable",
      "https://registry.npmjs.org/openclaw/2026.6.33",
    ]);
  });

  it("returns selector_missing for an absent public selector", async () => {
    const fetch = vi.fn(async () => new Response("not found", { status: 404 }));
    vi.stubGlobal("fetch", fetch);

    await expect(
      resolveExtendedStablePackage({ installKind: "package", timeoutMs: 1000 }),
    ).resolves.toEqual({ status: "failed", reason: "selector_missing" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("returns selector_query_failed for unusable selector metadata", async () => {
    const fetch = vi.fn(
      async () =>
        new Response("{", {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetch);

    await expect(
      resolveExtendedStablePackage({ installKind: "package", timeoutMs: 1000 }),
    ).resolves.toEqual({ status: "failed", reason: "selector_query_failed" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("returns exact_package_mismatch when exact readback differs", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ version: "2026.6.33" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ version: "2026.6.34" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    vi.stubGlobal("fetch", fetch);

    await expect(
      resolveExtendedStablePackage({ installKind: "package", timeoutMs: 1000 }),
    ).resolves.toEqual({ status: "failed", reason: "exact_package_mismatch" });
    expect(fetch.mock.calls.map((call) => String(call[0]))).not.toContain(
      "https://registry.npmjs.org/openclaw/latest",
    );
  });

  it("rejects Git installs before making a registry request", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);

    await expect(
      resolveExtendedStablePackage({ installKind: "git", timeoutMs: 1000 }),
    ).resolves.toEqual({ status: "failed", reason: "unsupported_git_channel" });
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("formatGitInstallLabel", () => {
  it("formats branch, detached tag, and non-git installs", () => {
    expect(
      formatGitInstallLabel({
        root: "/repo",
        installKind: "git",
        packageManager: "pnpm",
        git: {
          root: "/repo",
          sha: "1234567890abcdef",
          tag: null,
          branch: "main",
          upstream: "origin/main",
          dirty: false,
          ahead: 0,
          behind: 0,
          fetchOk: true,
        },
      }),
    ).toBe("main · @ 12345678");

    expect(
      formatGitInstallLabel({
        root: "/repo",
        installKind: "git",
        packageManager: "pnpm",
        git: {
          root: "/repo",
          sha: "abcdef1234567890",
          tag: "v1.2.3",
          branch: "HEAD",
          upstream: null,
          dirty: false,
          ahead: 0,
          behind: 0,
          fetchOk: null,
        },
      }),
    ).toBe("detached · tag v1.2.3 · @ abcdef12");

    expect(
      formatGitInstallLabel({
        root: null,
        installKind: "package",
        packageManager: "pnpm",
      }),
    ).toBeNull();
  });
});

describe("checkDepsStatus", () => {
  it("reports unknown, missing, stale, and ok states from lockfile markers", async () => {
    await withTempDir({ prefix: "openclaw-update-check-" }, async (base) => {
      await expect(checkDepsStatus({ root: base, manager: "unknown" })).resolves.toEqual({
        manager: "unknown",
        status: "unknown",
        lockfilePath: null,
        markerPath: null,
        reason: "unknown package manager",
      });

      await fs.writeFile(path.join(base, "pnpm-lock.yaml"), "lock", "utf8");
      const missingDeps = await checkDepsStatus({ root: base, manager: "pnpm" });
      expect(missingDeps.manager).toBe("pnpm");
      expect(missingDeps.status).toBe("missing");
      expect(missingDeps.reason).toBe("node_modules marker missing");

      const markerPath = path.join(base, "node_modules", ".modules.yaml");
      await fs.mkdir(path.dirname(markerPath), { recursive: true });
      await fs.writeFile(markerPath, "marker", "utf8");
      const staleDate = new Date(Date.now() - 10_000);
      const freshDate = new Date();
      await fs.utimes(markerPath, staleDate, staleDate);
      await fs.utimes(path.join(base, "pnpm-lock.yaml"), freshDate, freshDate);

      const staleDeps = await checkDepsStatus({ root: base, manager: "pnpm" });
      expect(staleDeps.manager).toBe("pnpm");
      expect(staleDeps.status).toBe("stale");
      expect(staleDeps.reason).toBe("lockfile newer than install marker");

      const newerMarker = new Date(Date.now() + 2_000);
      await fs.utimes(markerPath, newerMarker, newerMarker);
      const okDeps = await checkDepsStatus({ root: base, manager: "pnpm" });
      expect(okDeps.manager).toBe("pnpm");
      expect(okDeps.status).toBe("ok");
    });
  });

  it("uses npm-shrinkwrap as the npm dependency lock marker when present", async () => {
    await withTempDir({ prefix: "openclaw-update-check-shrinkwrap-" }, async (root) => {
      const shrinkwrapPath = path.join(root, "npm-shrinkwrap.json");
      await fs.writeFile(shrinkwrapPath, "{}", "utf8");
      await fs.mkdir(path.join(root, "node_modules"), { recursive: true });

      const deps = await checkDepsStatus({ root, manager: "npm" });

      expect(deps.manager).toBe("npm");
      expect(deps.status).toBe("ok");
      expect(deps.lockfilePath).toBe(shrinkwrapPath);
    });
  });
});

describe("checkUpdateStatus", () => {
  it("returns unknown install status when root is missing", async () => {
    await expect(
      checkUpdateStatus({ root: null, includeRegistry: false, timeoutMs: 1000 }),
    ).resolves.toEqual({
      root: null,
      installKind: "unknown",
      packageManager: "unknown",
      registry: undefined,
    });
  });

  it("detects package installs for non-git roots", async () => {
    await withTempDir({ prefix: "openclaw-update-check-" }, async (root) => {
      await fs.writeFile(
        path.join(root, "package.json"),
        JSON.stringify({ packageManager: "npm@10.0.0" }),
        "utf8",
      );
      await fs.writeFile(path.join(root, "package-lock.json"), "lock", "utf8");
      await fs.mkdir(path.join(root, "node_modules"), { recursive: true });

      const status = await checkUpdateStatus({
        root,
        includeRegistry: false,
        fetchGit: false,
        timeoutMs: 1000,
      });
      expect(status.root).toBe(root);
      expect(status.installKind).toBe("package");
      expect(status.packageManager).toBe("npm");
      expect(status.git).toBeUndefined();
      expect(status.registry).toBeUndefined();
      expect(status.deps?.manager).toBe("npm");
    });
  });

  it("detects npm package installs that ship pnpm package metadata with shrinkwrap", async () => {
    await withTempDir({ prefix: "openclaw-update-check-npm-shrinkwrap-" }, async (root) => {
      await fs.writeFile(
        path.join(root, "package.json"),
        JSON.stringify({ name: "openclaw", packageManager: "pnpm@11.2.2" }),
        "utf8",
      );
      await fs.writeFile(path.join(root, "npm-shrinkwrap.json"), "{}", "utf8");
      await fs.mkdir(path.join(root, "node_modules"), { recursive: true });

      const status = await checkUpdateStatus({
        root,
        includeRegistry: false,
        fetchGit: false,
        timeoutMs: 1000,
      });

      expect(status.installKind).toBe("package");
      expect(status.packageManager).toBe("npm");
      expect(status.deps?.manager).toBe("npm");
      expect(status.deps?.lockfilePath).toBe(path.join(root, "npm-shrinkwrap.json"));
    });
  });

  it("treats symlinked git installs as git roots", async () => {
    await withTempDir({ prefix: "openclaw-update-check-git-" }, async (base) => {
      const repoRoot = path.join(base, "repo");
      const linkedRoot = path.join(base, "linked-openclaw");
      await fs.mkdir(repoRoot, { recursive: true });
      await fs.writeFile(
        path.join(repoRoot, "package.json"),
        JSON.stringify({ name: "openclaw", packageManager: "pnpm@10.0.0" }),
        "utf8",
      );
      await runCommandWithTimeout(["git", "init"], { cwd: repoRoot, timeoutMs: 1000 });
      await fs.symlink(repoRoot, linkedRoot);

      const status = await checkUpdateStatus({
        root: linkedRoot,
        includeRegistry: false,
        fetchGit: false,
        timeoutMs: 1000,
      });
      expect(status.root).toBe(linkedRoot);
      expect(status.installKind).toBe("git");
      expect(status.git?.root).toBe(linkedRoot);
    });
  });

  it("reports unsupported_git_channel for Git status without querying npm", async () => {
    await withTempDir({ prefix: "openclaw-update-check-git-channel-" }, async (root) => {
      await fs.writeFile(
        path.join(root, "package.json"),
        JSON.stringify({ name: "openclaw", packageManager: "pnpm@10.0.0" }),
        "utf8",
      );
      await runCommandWithTimeout(["git", "init"], { cwd: root, timeoutMs: 1000 });
      const fetch = vi.fn();
      vi.stubGlobal("fetch", fetch);
      try {
        const status = await checkUpdateStatus({
          root,
          includeRegistry: true,
          registryChannel: "extended-stable",
          fetchGit: false,
          timeoutMs: 1000,
        });

        expect(status.registry).toEqual({
          latestVersion: null,
          tag: "extended-stable",
          error: "unsupported_git_channel",
          reason: "unsupported_git_channel",
        });
        expect(fetch).not.toHaveBeenCalled();
      } finally {
        vi.unstubAllGlobals();
      }
    });
  });
});
