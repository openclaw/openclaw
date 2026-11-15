import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  collectAllResolvedPackagesFromLockfile,
  collectProdResolvedPackagesFromLockfile,
  createBulkAdvisoryPayload,
  fetchBulkAdvisories,
  filterFindingsBySeverity,
  parseArgs,
  readBoundedBulkAdvisoryErrorText,
  runPnpmAuditProd,
} from "../../scripts/pre-commit/pnpm-audit-prod.mjs";
import { createScriptTestHarness } from "./test-helpers.js";

vi.mock("node:timers/promises", () => ({ setTimeout: vi.fn(async () => {}) }));
const { createTempDirAsync } = createScriptTestHarness();
beforeEach(() => vi.mocked(delay).mockReset().mockResolvedValue(undefined));
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
const mistralAdvisory = {
  id: "1118204",
  severity: "critical",
  title: "Malware in @mistralai/mistralai",
  vulnerable_versions: ">=0",
  url: "https://github.com/advisories/GHSA-3q49-cfcf-g5fm",
};
const { vulnerable_versions: vulnerableVersions, ...mistralFinding } = mistralAdvisory;
const highAdvisory = {
  id: "GHSA-high",
  severity: "high",
  title: "high issue",
  url: "https://github.com/advisories/GHSA-high",
};
function expectText(text: string, ...parts: string[]) {
  for (const part of parts) {
    expect(text).toContain(part);
  }
}
function captureOutput(chunks: string[]) {
  return {
    write: (chunk: string) => {
      chunks.push(chunk);
      return true;
    },
  };
}
async function auditFixture(packageNames: string[]) {
  const root = await createTempDirAsync("openclaw-audit-");
  await writeFile(
    path.join(root, "pnpm-lock.yaml"),
    [
      "lockfileVersion: '9.0'",
      "importers:",
      "  .:",
      "    dependencies:",
      ...packageNames.map((name) => `      ${name}: {version: 1.0.0}`),
      "snapshots:",
      ...packageNames.map((name) => `  ${name}@1.0.0: {}`),
    ].join("\n"),
  );
  const stdout: string[] = [],
    stderr: string[] = [];
  const summaryPath = path.join(root, "summary.md");
  vi.stubEnv("GITHUB_STEP_SUMMARY", summaryPath);
  return {
    stdout,
    stderr,
    summary: () => readFile(summaryPath, "utf8"),
    run: (fetchImpl: typeof fetch) =>
      runPnpmAuditProd({
        rootDir: root,
        fetchImpl,
        stdout: captureOutput(stdout),
        stderr: captureOutput(stderr),
      }),
  };
}
const transportError = (message: string, code: string) =>
  new TypeError(message, { cause: Object.assign(new Error(), { code }) });
const fetchAdvisories = (options: Omit<Parameters<typeof fetchBulkAdvisories>[0], "payload">) =>
  fetchBulkAdvisories({ payload: { axios: ["1.0.0"] }, ...options });
const stalledResponse = (status: number, cancel: () => void) =>
  new Response(new ReadableStream({ pull: () => new Promise(() => {}), cancel }), { status });
function requestPayload(init: RequestInit | undefined) {
  if (typeof init?.body !== "string") {
    throw new Error("Expected a JSON request body");
  }
  return JSON.parse(init.body);
}

function expectGraph(importers: string, snapshots: string, expected: Record<string, string[]>) {
  const lock = `lockfileVersion: '9.0'\nimporters:\n${importers}\nsnapshots:\n${snapshots}`;
  expect(createBulkAdvisoryPayload(collectProdResolvedPackagesFromLockfile(lock))).toEqual(
    expected,
  );
}

it("keeps toolchain snapshots separate from production while auditing both documents", () => {
  const lockfile = `---
lockfileVersion: '9.0'
importers:
  .:
    packageManagerDependencies:
      pnpm: {specifier: 12.0.0, version: 12.0.0}
snapshots:
  pnpm@12.0.0:
    optionalDependencies:
      native: 2.0.0
  native@2.0.0: {}
  shared@1.0.0:
    dependencies:
      tool-only: 1.0.0
  tool-only@1.0.0: {}
---
lockfileVersion: '9.0'
importers:
  .:
    dependencies:
      shared: {version: 1.0.0}
snapshots:
  shared@1.0.0: {}
`;
  expect(createBulkAdvisoryPayload(collectProdResolvedPackagesFromLockfile(lockfile))).toEqual({
    shared: ["1.0.0"],
  });
  expect(createBulkAdvisoryPayload(collectAllResolvedPackagesFromLockfile(lockfile))).toEqual({
    native: ["2.0.0"],
    pnpm: ["12.0.0"],
    shared: ["1.0.0"],
    "tool-only": ["1.0.0"],
  });
  const brokenApplication = lockfile.replace(
    "  shared@1.0.0: {}",
    "  shared@1.0.0:\n    dependencies:\n      native: 2.0.0",
  );
  expect(() => collectProdResolvedPackagesFromLockfile(brokenApplication)).toThrow(
    "Unable to resolve pnpm snapshot",
  );
});
it("parses explicit audit severity flags", () => {
  expect(parseArgs(["--min-severity", "critical"])).toEqual({ minSeverity: "critical" });
  expect(parseArgs(["--audit-level=moderate"])).toEqual({ minSeverity: "moderate" });
  expect(parseArgs(["--ci"])).toEqual({ minSeverity: "high", budgetMs: 30_000 });
});

it("rejects missing audit severity flag values", () => {
  expect(() => parseArgs(["--min-severity"])).toThrow("--min-severity requires a value");
  expect(() => parseArgs(["--min-severity", "-h"])).toThrow("--min-severity requires a value");
  expect(() => parseArgs(["--audit-level="])).toThrow("--audit-level requires a value");
});

it("rejects unsupported audit levels", () => {
  expect(() => filterFindingsBySeverity({}, "unknown")).toThrow("Unsupported audit level");
});

it.each<[string, string, string, Record<string, string[]>]>([
  [
    "resolves production, optional, aliased and tarball dependencies without development or workspace edges",
    `  .:
    dependencies:
      pkg-a:
        version: 1.0.0
      request:
        version: npm:@cypress/request@3.0.10
    devDependencies:
      dev-only: {version: 9.9.9}
  extensions/demo:
    dependencies:
      '@scope/pkg': {'version': '2.0.0(peer@4.0.0)'}
      workspace-lib: {version: link:../../packages/workspace-lib}`,
    `  pkg-a@1.0.0:
    dependencies:
      transitive: 3.0.0(patch_hash=abc123)
      libsignal: '@whiskeysockets/libsignal-node@https://codeload.github.com/whiskeysockets/libsignal-node/tar.gz/abc123'
  transitive@3.0.0(patch_hash=abc123): {}
  '@scope/pkg@2.0.0(peer@4.0.0)':
    optionalDependencies:
      opt-dep: 4.0.0
  opt-dep@4.0.0: {}
  '@cypress/request@3.0.10': {}
  '@whiskeysockets/libsignal-node@https://codeload.github.com/whiskeysockets/libsignal-node/tar.gz/abc123':
    dependencies:
      curve25519-js: 0.0.4
  curve25519-js@0.0.4: {}`,
    {
      "@cypress/request": ["3.0.10"],
      "@scope/pkg": ["2.0.0"],
      "@whiskeysockets/libsignal-node": [
        "https://codeload.github.com/whiskeysockets/libsignal-node/tar.gz/abc123",
      ],
      "curve25519-js": ["0.0.4"],
      "opt-dep": ["4.0.0"],
      "pkg-a": ["1.0.0"],
      transitive: ["3.0.0"],
    },
  ],
  [
    "audits bundled Mistral and its transitives without unrelated development dependencies",
    `  .:
    devDependencies:
      '@mistralai/mistralai': {version: 3.0.0}
  packages/ai:
    devDependencies:
      '@mistralai/mistralai': {version: 2.7.0}
      build-tool: {version: 1.0.0}`,
    `  '@mistralai/mistralai@2.7.0':
    dependencies:
      schema: 1.0.0
    optionalDependencies:
      telemetry: 2.0.0
  schema@1.0.0: {}
  telemetry@2.0.0: {}
  '@mistralai/mistralai@3.0.0': {}
  build-tool@1.0.0: {}`,
    { "@mistralai/mistralai": ["2.7.0"], schema: ["1.0.0"], telemetry: ["2.0.0"] },
  ],
])("%s", (_name, importers, snapshots, expected) => expectGraph(importers, snapshots, expected));

it.each(["2.2.1", "2.2.4"])("applies the Mistral malware override to locked %s", (version) => {
  const findings = filterFindingsBySeverity(
    { "@mistralai/mistralai": [mistralAdvisory] },
    "high",
    new Map([["@mistralai/mistralai", new Set([version])]]),
  );
  const finding = { ...mistralFinding, packageName: "@mistralai/mistralai", vulnerableVersions };
  expect(findings).toEqual(version === "2.2.1" ? [] : [finding]);
});

it("preserves a complete surrogate pair when truncating bulk advisory errors", async () => {
  const response = new Response(`ab\u{1f600}tail`, { status: 500 });
  await expect(readBoundedBulkAdvisoryErrorText(response, 4)).resolves.toBe(
    `ab\u{1f600}\n[truncated]`,
  );
});

it("honors Retry-After 10 on 429", async () => {
  vi.spyOn(performance, "now").mockReturnValue(0);
  const signals: (AbortSignal | null | undefined)[] = [];
  const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    signals.push(init?.signal);
    return signals.length === 1
      ? new Response("rate limited", { status: 429, headers: { "retry-after": "10" } })
      : new Response("{}");
  });
  await expect(fetchAdvisories({ fetchImpl })).resolves.toEqual({});
  expect(fetchImpl).toHaveBeenCalledTimes(2);
  expect(delay).toHaveBeenCalledExactlyOnceWith(10_000);
  expect(signals.every((signal) => signal instanceof AbortSignal)).toBe(true);
  expect(new Set(signals).size).toBe(2);
});

it("does not retry empty bodies", async () => {
  const fetchImpl = vi.fn(async () => new Response("", { status: 200 }));
  await expect(fetchAdvisories({ fetchImpl })).rejects.toThrow(
    /Bulk advisory response body was empty/u,
  );
  expect(fetchImpl).toHaveBeenCalledOnce();
});

it.each(
  [
    null,
    { axios: [null] },
    { axios: [{ id: 1, severity: "high", vulnerable_versions: null }] },
  ].map((body) => ({ body })),
)("rejects malformed advisory data without retry: $body", async ({ body }) => {
  const fetchImpl = vi.fn(async () => Response.json(body));
  await expect(fetchAdvisories({ fetchImpl })).rejects.toThrow("Invalid bulk advisory response");
  expect(fetchImpl).toHaveBeenCalledOnce();
});

it("bounds stalled HTTP 200 bodies by the total budget", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  let cancelled = false;
  let signal: AbortSignal | null | undefined;
  const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    signal = init?.signal;
    return stalledResponse(200, () => {
      cancelled = true;
    });
  });
  const request = expect(
    fetchAdvisories({
      fetchImpl,
      timeoutMs: Number.MAX_SAFE_INTEGER,
      budgetMs: 20,
    }),
  ).rejects.toThrow("timeout");
  await vi.advanceTimersByTimeAsync(19);
  expect(cancelled).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  expect(fetchImpl).toHaveBeenCalledOnce();
  expect(cancelled).toBe(true);
  expect(signal?.aborted).toBe(true);
  await request;
});

it("does not downgrade hard errors when backoff resumes after the deadline", async () => {
  let elapsed = 0;
  vi.spyOn(performance, "now").mockImplementation(() => elapsed);
  const failure = transportError("invalid URL", "ERR_INVALID_URL");
  const fetchImpl = vi.fn(async () => {
    throw failure;
  });
  vi.mocked(delay).mockImplementation(async () => {
    elapsed = 2501;
  });
  await expect(fetchAdvisories({ fetchImpl, budgetMs: 2500 })).rejects.toBe(failure);
  expect(fetchImpl).toHaveBeenCalledOnce();
});

it.each([
  ["HTTP 503", () => new Response("unavailable", { status: 503 }), 2, 4],
  [
    "HTTP 403 with a stalled error body",
    (onCancel: () => void) => stalledResponse(403, onCancel),
    null,
    1,
  ],
  [
    "invalid registry URL",
    () => {
      throw transportError("invalid URL", "ERR_INVALID_URL");
    },
    null,
    4,
  ],
  [
    "connection lost while reading a response",
    () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.error(transportError("terminated", "UND_ERR_SOCKET"));
          },
        }),
      ),
    2,
    4,
  ],
  ["invalid JSON", () => new Response("{"), null, 1],
] as const)(
  "preserves whole-graph audit failure outcomes: %s",
  async (name, response, exit, attempts) => {
    const packages = Array.from({ length: 401 }, (_, index) => `pkg-${index}`);
    const fixture = await auditFixture(packages);
    let requests = 0;
    let cancellations = 0;
    vi.stubEnv("OPENCLAW_PNPM_AUDIT_BULK_TIMEOUT_MS", "10");
    const audit = fixture.run(async (_input, init) => {
      requests++;
      expect(Object.keys(requestPayload(init))).toHaveLength(401);
      return response(() => {
        cancellations += 1;
      });
    });
    if (exit === null) {
      await expect(audit).rejects.toThrow(
        name === "HTTP 403 with a stalled error body"
          ? /Bulk advisory request failed \(403/u
          : undefined,
      );
    } else {
      await expect(audit).resolves.toBe(exit);
      expect(fixture.stderr.join("")).toContain("incomplete");
    }
    expect(fixture.stdout).toEqual([]);
    expect(requests).toBe(attempts);
    if (name === "HTTP 403 with a stalled error body") {
      expect(cancellations).toBe(1);
    }
    expectText(
      await fixture.summary(),
      `Outcome: **${exit === null ? "error" : "unavailable"}**`,
      "no clearance",
    );
  },
);

it.each([false, true])(
  "submits one complete graph and reports npm-only coverage (blocked %s)",
  async (blocked) => {
    const packageNames = [
      "axios",
      ...Array.from({ length: 400 }, (_, index) => `fixture-${index}`),
    ];
    const fixture = await auditFixture(packageNames);
    const { stdout: stdoutChunks, stderr: stderrChunks } = fixture;
    const payloads: unknown[] = [];
    const exitCode = await fixture.run(async (input, init) => {
      payloads.push(requestPayload(init));
      const url = input instanceof URL ? input.href : input instanceof Request ? input.url : input;
      expect(url).toMatch(/\/-\/npm\/v1\/security\/advisories\/bulk$/u);
      return Response.json(
        blocked
          ? {
              axios: [
                { ...highAdvisory, vulnerable_versions: "<=1.0.0" },
                {
                  ...highAdvisory,
                  id: "GHSA-moderate",
                  severity: "moderate",
                  vulnerable_versions: "<=1.0.0",
                },
              ],
            }
          : {},
      );
    });

    expect(exitCode).toBe(blocked ? 1 : 0);
    const summary = await fixture.summary();
    expectText(summary, `Outcome: **${blocked ? "findings" : "complete"}**`, "Packages: 401");
    expect(payloads).toEqual([Object.fromEntries(packageNames.map((name) => [name, ["1.0.0"]]))]);
    if (blocked) {
      expect(stdoutChunks).toStrictEqual([]);
      expectText(
        stderrChunks.join(""),
        "Found 1 high or higher advisories from npm bulk",
        "upstream repository advisories not checked",
      );
    } else {
      expect(stderrChunks).toStrictEqual([]);
      expectText(
        stdoutChunks.join(""),
        "No matching high or higher advisories returned by npm bulk",
        "Upstream repository advisories were not checked",
        "not a full vulnerability assessment",
      );
    }
  },
);
