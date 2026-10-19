import fs from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { runCommandWithTimeout } from "../process/exec.js";
import { parsePackageOpenClawSchemaVersions } from "../state/openclaw-schema-versions.js";
import { withTestDir } from "../test-helpers/temp-dir.js";
import { useMockHttp } from "../test-utils/mock-http.js";
import {
  fetchNpmPackageTargetStatus,
  type NpmMetadataCommandRunner,
} from "./update-check-package-target.js";
import {
  checkUpdateStatus,
  compareSemverStrings,
  fetchNpmTagVersion,
  formatGitInstallLabel,
  resolveExtendedStablePackage,
  resolveNpmChannelTag,
} from "./update-check.js";

const mockHttp = useMockHttp();
const registryUrl = (target: string) => `https://registry.npmjs.org/openclaw/${target}`;
function registryReply(target: string, reply: Parameters<typeof mockHttp.intercept>[0]["reply"]) {
  mockHttp.intercept({ url: registryUrl(target), reply });
}
const packageTarget = (options: Parameters<typeof fetchNpmPackageTargetStatus>[0]) =>
  fetchNpmPackageTargetStatus({ timeoutMs: 1000, ...options });
const registryStatus = (options: Partial<Parameters<typeof checkUpdateStatus>[0]>) =>
  checkUpdateStatus({ root: null, includeRegistry: true, timeoutMs: 1000, ...options });
const extendedStable = (
  options: Partial<Parameters<typeof resolveExtendedStablePackage>[0]> = {},
) => resolveExtendedStablePackage({ installKind: "package", timeoutMs: 1000, ...options });
const commandResult = (value: unknown) => ({ stdout: JSON.stringify(value), stderr: "", code: 0 });
const mockVersions = (versions: Record<string, string>) =>
  vi.fn<NpmMetadataCommandRunner>(async (argv) => {
    const version = versions[(argv[2] ?? "").split("@").at(-1) ?? ""];
    return version
      ? commandResult({ version, "engines.node": ">=22.19.0" })
      : { stdout: "", stderr: "npm ERR! 404 Not Found", code: 1 };
  });
const legacySchemaVersions = { state: 1, agent: 1 };
const packageMetadata = (version: string, node = ">=22.19.0") => ({
  version,
  engines: { node },
});
function expectPackageError(
  result: Awaited<ReturnType<typeof packageTarget>>,
  error: string | string[],
) {
  expect(result).toMatchObject({ version: null, nodeEngine: null });
  if (typeof error === "string") {
    expect(result.error).toBe(error);
  } else {
    for (const fragment of error) {
      expect(result.error).toContain(fragment);
    }
  }
}

const writeJson = (file: string, value: object) => fs.writeFile(file, JSON.stringify(value));

it.each([
  {
    name: "extended-stable verification",
    run: async () => {
      const result = await resolveExtendedStablePackage({ installKind: "package", env: {} });
      return result.status === "resolved" ? result.version : null;
    },
  },
  {
    name: "update status",
    run: async () =>
      (await checkUpdateStatus({ root: null, includeRegistry: true })).registry?.latestVersion,
  },
])("allows slow registry metadata for $name", async ({ run }) => {
  vi.useFakeTimers();
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>(async (_input, init) => {
      const signal = init?.signal;
      if (!signal) {
        throw new Error("Registry request has no watchdog");
      }
      return await new Promise<Response>((resolve, reject) => {
        const abort = () => {
          clearTimeout(timer);
          reject(new Error("Registry request aborted"));
        };
        const timer = setTimeout(() => {
          signal.removeEventListener("abort", abort);
          resolve(Response.json({ version: "2026.8.33" }));
        }, 299_000);
        signal.addEventListener("abort", abort, { once: true });
      });
    }),
  );
  const result = run();
  await vi.advanceTimersByTimeAsync(598_000);
  await expect(result).resolves.toBe("2026.8.33");
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it.each([
  ["2026.6.5", "2026.6.6-beta.1", -1],
  ["2026.6.6", "2026.6.6-beta.1", 1],
  ["2026.6.6-beta.2", "2026.6.6-beta.1", 1],
  ["v2026.6.6", "2026.6.6", 0],
  ["2026.6.6.beta.2", "2026.6.6-beta.1", 1],
  ["2026.5.3", "2026.5.3-1", -1],
  ["2026.5.3-1", "2026.5.3", 1],
  ["2026.5.3-2", "2026.5.3-1", 1],
  ["1.0", "1.0.0", null],
  ["latest", "1.0.0", null],
] as const)("compares %s against %s as %s", (a, b, expected) => {
  expect(compareSemverStrings(a, b)).toBe(expected);
});

it.each([
  { version: "2026.7.1", packageName: "@example/openclaw", expected: undefined },
  { version: "2026.7.1", schemaVersions: null, expected: undefined },
])(
  "retains shipped legacy schema limits across metadata readers: $version $packageName $schemaVersions",
  async ({ version, packageName = "openclaw", schemaVersions, expected }) => {
    const manifest = {
      name: packageName,
      version,
      ...(schemaVersions === undefined ? {} : { openclaw: { schemaVersions } }),
    };
    expect(parsePackageOpenClawSchemaVersions(manifest)).toEqual(expected);
    mockHttp.intercept({
      url: `https://registry.npmjs.org/${encodeURIComponent(packageName)}/${version}`,
      reply: { json: manifest },
    });
    const registry = await fetchNpmPackageTargetStatus({ target: version, packageName });
    const npm = await fetchNpmPackageTargetStatus({
      target: version,
      spec: `${packageName}@${version}`,
      runCommand: async () =>
        commandResult({
          version,
          ...(schemaVersions === undefined ? {} : { "openclaw.schemaVersions": schemaVersions }),
        }),
    });
    expect(registry.schemaVersions).toEqual(expected);
    expect(npm.schemaVersions).toEqual(expected);
  },
);

it("normalizes npm 12 singleton-array metadata", async () => {
  const schemaVersions = { state: 3, agent: 11 };
  const runCommand = async () =>
    commandResult([
      {
        ...packageMetadata("2026.7.1", ">=22.22.3"),
        openclaw: { schemaVersions },
      },
    ]);

  await expect(packageTarget({ target: "latest", runCommand })).resolves.toEqual({
    version: "2026.7.1",
    nodeEngine: ">=22.22.3",
    schemaVersions,
  });
});

it("uses npm global scope, user config auth, and ignores project npmrc for real metadata", async () => {
  await withTestDir({ prefix: "openclaw-update-check-npm-view-" }, async (base) => {
    const requests: Array<{ url: string; authorization?: string }> = [];
    await using server = http.createServer((req, res) => {
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
              ...packageMetadata("2026.6.6"),
            },
          },
        }),
      );
    });

    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
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
      version: "2026.6.6",
      nodeEngine: ">=22.19.0",
      schemaVersions: legacySchemaVersions,
    });

    expect(requests.some((request) => request.url.startsWith("/user/openclaw"))).toBe(true);
    expect(requests.some((request) => request.url.startsWith("/project/"))).toBe(false);
    expect(requests.some((request) => request.authorization === "Bearer test-token")).toBe(true);
  });
});

it("uses the public registry when no npm command is available", async () => {
  registryReply("latest", { json: packageMetadata("2026.6.8") });

  await expect(packageTarget({ target: "latest" })).resolves.toEqual({
    version: "2026.6.8",
    nodeEngine: ">=22.19.0",
    schemaVersions: legacySchemaVersions,
  });
});

it("times out when the public registry response body stalls after headers", async () => {
  vi.useFakeTimers();
  const fetchMock = vi.fn<typeof fetch>(async (_input, init) => {
    const signal = init?.signal;
    if (!signal) {
      throw new Error("missing registry request signal");
    }
    return new Response(
      new ReadableStream({
        start(controller) {
          signal.addEventListener("abort", () => controller.error(signal.reason), {
            once: true,
          });
        },
      }),
      { headers: { "content-type": "application/json" } },
    );
  });
  vi.stubGlobal("fetch", fetchMock);

  const resultPromise = Promise.race([
    fetchNpmPackageTargetStatus({ target: "latest", timeoutMs: 50 }),
    new Promise<never>((_resolve, reject) => {
      setTimeout(() => reject(new Error("registry response body exceeded timeoutMs")), 2000);
    }),
  ]);
  await vi.advanceTimersByTimeAsync(2000);

  expectPackageError(await resultPromise, "TimeoutError: request timed out");
  expect(fetchMock).toHaveBeenCalledWith(
    registryUrl("latest"),
    expect.objectContaining({ signal: expect.any(AbortSignal) }),
  );
});

it("cancels public registry HTTP failure bodies", async () => {
  const cancel = vi.spyOn(ReadableStream.prototype, "cancel");
  registryReply("latest", { status: 503, body: "unavailable" });

  expect(await packageTarget({ target: "latest" })).toEqual({
    version: null,
    nodeEngine: null,
    error: "HTTP 503",
  });
  expect(cancel).toHaveBeenCalledTimes(1);
});

it("returns error on oversized public registry response exceeding 16 MiB", async () => {
  const ONE_MIB = 1024 * 1024;
  registryReply("latest", {
    body: Buffer.alloc(16 * ONE_MIB + 1, 0x41),
    headers: { "content-type": "application/json" },
  });

  const result = await fetchNpmPackageTargetStatus({ target: "latest", timeoutMs: 5000 });
  expectPackageError(result, ["JSON response exceeds", "16777216"]);
});

it("falls back to latest when beta is older", async () => {
  const runCommand = mockVersions({ beta: "1.0.0-beta.1", latest: "1.0.1-1" });

  const resolved = await resolveNpmChannelTag({ channel: "beta", timeoutMs: 1000, runCommand });

  expect(resolved).toMatchObject({
    tag: "latest",
    version: "1.0.1-1",
    metadata: { nodeEngine: ">=22.19.0" },
  });
});

it("resolves beta and stable within one registry response delay", async () => {
  vi.useFakeTimers();
  try {
    const runCommand = vi.fn<NpmMetadataCommandRunner>(async (argv) => {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 200);
      });
      return commandResult({
        version: argv[2] === "openclaw@beta" ? "2026.9.1-beta.1" : "2026.8.30",
      });
    });
    const completed = vi.fn();
    const pending = resolveNpmChannelTag({ channel: "beta", timeoutMs: 1000, runCommand });
    void pending.then(completed);

    await vi.advanceTimersByTimeAsync(200);

    expect(completed).toHaveBeenCalledWith(
      expect.objectContaining({ tag: "beta", version: "2026.9.1-beta.1" }),
    );
    await pending;
  } finally {
    await vi.runAllTimersAsync();
    vi.useRealTimers();
  }
});

it("fetches registry tag versions and reports missing tags", async () => {
  const runCommand = mockVersions({ latest: "1.0.4" });
  await expect(
    fetchNpmTagVersion({ tag: "latest", timeoutMs: 1000, runCommand }),
  ).resolves.toMatchObject({
    tag: "latest",
    version: "1.0.4",
    metadata: { nodeEngine: ">=22.19.0" },
  });
  await expect(
    fetchNpmTagVersion({ tag: "missing", timeoutMs: 1000, runCommand }),
  ).resolves.toMatchObject({
    tag: "missing",
    version: null,
    error: "npm view failed: npm ERR! 404 Not Found",
  });
});

it("adds context to malformed npm view JSON errors", async () => {
  const runCommand = vi.fn(async () => ({ stdout: "not valid json {", stderr: "", code: 0 }));

  const result = await packageTarget({
    target: "openclaw",
    runCommand,
  });

  expectPackageError(result, ["npm view returned invalid JSON", "SyntaxError"]);
});
it("does not query the selector after the channel request was aborted", async () => {
  const controller = new AbortController();
  controller.abort();

  await expect(
    resolveNpmChannelTag({ channel: "extended-stable", signal: controller.signal }),
  ).rejects.toMatchObject({ name: "AbortError" });
  expect(mockHttp.requests()).toHaveLength(0);
});

it("does not query the exact package after cancellation during selector lookup", async () => {
  const controller = new AbortController();
  const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
    controller.abort();
    return Response.json({ version: "2026.6.33" });
  });

  await expect(
    registryStatus({
      registryChannel: "extended-stable",
      signal: controller.signal,
      timeoutMs: undefined,
    }),
  ).rejects.toMatchObject({ name: "AbortError" });
  expect(fetchSpy).toHaveBeenCalledTimes(1);
});

it.each([
  ["http://127.0.0.1:4873/", "@kevins8/openclaw", "2000.4.34"],
  ["https://registry.example.com/", "openclaw", "2026.6.33"],
])("allows package overrides only for loopback registries: %s", async (registry, name, version) => {
  const base = name === "openclaw" ? "https://registry.npmjs.org/" : registry;
  for (const target of ["extended-stable", version]) {
    mockHttp.intercept({
      url: `${base}${encodeURIComponent(name)}/${target}`,
      reply: { json: { version } },
    });
  }
  await expect(
    extendedStable({
      packageName: "@kevins8/openclaw",
      env: { OPENCLAW_UPDATE_PACKAGE_SPEC: "@kevins8/openclaw", NPM_CONFIG_REGISTRY: registry },
    }),
  ).resolves.toEqual({
    status: "resolved",
    selector: "extended-stable",
    version,
    packageSpec: `${name}@${version}`,
  });
});

it.each([
  { reason: "selector_missing", reply: { status: 404, body: "not found" } },
  {
    reason: "selector_query_failed",
    reply: { body: "{", headers: { "content-type": "application/json" } },
  },
])("returns $reason for an unusable public selector", async ({ reason, reply }) => {
  registryReply("extended-stable", reply);
  await expect(extendedStable()).resolves.toEqual({ status: "failed", reason });
});

it("returns exact_package_mismatch when exact readback differs", async () => {
  registryReply("extended-stable", { json: { version: "2026.6.33" } });
  registryReply("2026.6.33", { json: { version: "2026.6.34" } });

  await expect(extendedStable()).resolves.toEqual({
    status: "failed",
    reason: "exact_package_mismatch",
  });
  expect(mockHttp.requests().map((request) => request.fullUrl)).not.toContain(
    "https://registry.npmjs.org/openclaw/latest",
  );
});

it("rejects Git installs before making a registry request", async () => {
  await expect(extendedStable({ installKind: "git" })).resolves.toEqual({
    status: "failed",
    reason: "unsupported_git_channel",
  });
  expect(mockHttp.requests()).toHaveLength(0);
});
it("formats branch, detached tag, and non-git installs", () => {
  const label = (git: Partial<NonNullable<Parameters<typeof formatGitInstallLabel>[0]["git"]>>) =>
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
        ...git,
      },
    });
  expect(label({})).toBe("main · @ 12345678");
  expect(
    label({
      sha: "abcdef1234567890",
      tag: "v1.2.3",
      branch: "HEAD",
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

it.each(["beta", "latest"])(
  "uses the available beta-channel target when %s fails",
  async (failedTag) => {
    const selectedTag = failedTag === "beta" ? "latest" : "beta";
    for (const tag of ["beta", "latest"]) {
      registryReply(
        tag,
        tag === failedTag
          ? { status: 503, body: "unavailable" }
          : { json: { version: "2026.6.6" } },
      );
    }

    const status = await registryStatus({ registryChannel: "beta" });

    expect(status.registry).toEqual({ latestVersion: "2026.6.6", tag: selectedTag });
  },
);

it("reports unsupported_git_channel for Git status without querying npm", async () => {
  await withTestDir({ prefix: "openclaw-update-check-git-channel-" }, async (root) => {
    await writeJson(path.join(root, "package.json"), {
      name: "openclaw",
      packageManager: "pnpm@12.0.0",
    });
    const initialized = await runCommandWithTimeout(["git", "init"], {
      cwd: root,
      timeoutMs: 1000,
    });
    expect(initialized, initialized.stderr).toMatchObject({ code: 0, termination: "exit" });
    const status = await registryStatus({
      root,
      registryChannel: "extended-stable",
      fetchGit: false,
    });

    expect(status.registry).toEqual({
      latestVersion: null,
      tag: "extended-stable",
      error: "unsupported_git_channel",
      reason: "unsupported_git_channel",
    });
    expect(mockHttp.requests()).toHaveLength(0);
  });
});
