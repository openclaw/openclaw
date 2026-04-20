import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const noteMock = vi.hoisted(() => vi.fn());

vi.mock("../terminal/note.js", () => ({
  note: noteMock,
}));

import { evaluateRebuildGuard, noteRebuildGuardHealth } from "./doctor-rebuild-guard.js";

const now = new Date("2026-04-20T13:00:00.000Z");

type FetchStub = ReturnType<typeof vi.fn> & typeof fetch;

let tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "openclaw-rebuild-guard-"));
  tempDirs.push(dir);
  return dir;
}

function writePackageFixture(
  params: {
    packageRoot?: string;
    version?: string;
    builtAt?: string;
    commit?: string;
    buildInfoRaw?: string;
    omitBuildInfo?: boolean;
  } = {},
): string {
  const packageRoot = params.packageRoot ?? makeTempDir();
  const version = params.version ?? "2026.4.15";
  mkdirSync(path.join(packageRoot, "dist"), { recursive: true });
  writeFileSync(path.join(packageRoot, "package.json"), `${JSON.stringify({ version })}\n`, "utf8");
  if (!params.omitBuildInfo) {
    const buildInfo =
      params.buildInfoRaw ??
      JSON.stringify({
        version,
        builtAt: params.builtAt ?? "2026-04-16T12:30:00.000Z",
        commit: params.commit ?? "abc123",
      });
    writeFileSync(path.join(packageRoot, "dist", "build-info.json"), `${buildInfo}\n`, "utf8");
  }
  return packageRoot;
}

function registryBody(time: Record<string, string>): string {
  return JSON.stringify({ time });
}

function makeFetch(body: string): FetchStub {
  return vi.fn(async () => ({
    ok: true,
    text: async () => body,
  })) as FetchStub;
}

afterEach(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tempDirs = [];
  delete process.env.OPENCLAW_NPM_REGISTRY_FILE;
  vi.restoreAllMocks();
});

beforeEach(() => {
  noteMock.mockClear();
});

describe("evaluateRebuildGuard", () => {
  it("returns pristine without emitting a note when build metadata is near the npm publish time", async () => {
    const packageRoot = writePackageFixture({
      builtAt: "2026-04-16T12:30:00.000Z",
    });
    const fetchFn = makeFetch(
      registryBody({
        "2026.4.15": "2026-04-16T12:00:00.000Z",
      }),
    );

    const result = await evaluateRebuildGuard({
      packageRoot,
      fetchFn,
      now: () => now,
      cacheFile: path.join(makeTempDir(), "registry.json"),
    });

    expect(result).toMatchObject({
      verdict: "pristine",
      version: "2026.4.15",
      builtAt: "2026-04-16T12:30:00.000Z",
      npmPublishedAt: "2026-04-16T12:00:00.000Z",
      reason: "within-skew-window",
    });
    expect(noteMock).not.toHaveBeenCalled();
  });

  it("returns rebuild with skew minutes and emits one note with the reason", async () => {
    const packageRoot = writePackageFixture({
      builtAt: "2026-04-19T12:00:00.000Z",
    });
    const fetchFn = makeFetch(
      registryBody({
        "2026.4.15": "2026-04-16T12:00:00.000Z",
      }),
    );
    const cacheFile = path.join(makeTempDir(), "registry.json");

    const result = await evaluateRebuildGuard({
      packageRoot,
      fetchFn,
      now: () => now,
      cacheFile,
    });

    expect(result).toMatchObject({
      verdict: "rebuild",
      reason: "builtAt-after-publish",
      skewMinutes: 72 * 60,
    });

    await noteRebuildGuardHealth(packageRoot, {
      fetchFn,
      now: () => now,
      cacheFile,
    });

    expect(noteMock).toHaveBeenCalledOnce();
    expect(noteMock.mock.calls[0]?.[0]).toContain("- Reason: builtAt-after-publish");
  });

  it("returns unreleased and emits a note when the local version is absent from the registry time map", async () => {
    const packageRoot = writePackageFixture();
    const fetchFn = makeFetch(
      registryBody({
        "2026.4.14": "2026-04-14T12:00:00.000Z",
      }),
    );
    const cacheFile = path.join(makeTempDir(), "registry.json");

    const result = await evaluateRebuildGuard({
      packageRoot,
      fetchFn,
      now: () => now,
      cacheFile,
    });

    expect(result).toMatchObject({
      verdict: "unreleased",
      reason: "version-unreleased",
    });

    await noteRebuildGuardHealth(packageRoot, {
      fetchFn,
      now: () => now,
      cacheFile,
    });
    expect(noteMock).toHaveBeenCalledOnce();
    expect(noteMock.mock.calls[0]?.[0]).toContain("- Reason: version-unreleased");
  });

  it("returns corrupt and emits a note when build-info.json is missing or malformed", async () => {
    const missingBuildInfoRoot = writePackageFixture({ omitBuildInfo: true });

    const missingResult = await evaluateRebuildGuard({
      packageRoot: missingBuildInfoRoot,
      fetchFn: makeFetch(registryBody({})),
      now: () => now,
      cacheFile: path.join(makeTempDir(), "registry.json"),
    });

    expect(missingResult).toMatchObject({
      verdict: "corrupt",
      reason: "build-info-missing",
    });

    const malformedBuildInfoRoot = writePackageFixture({ buildInfoRaw: "{" });
    const malformedResult = await evaluateRebuildGuard({
      packageRoot: malformedBuildInfoRoot,
      fetchFn: makeFetch(registryBody({})),
      now: () => now,
      cacheFile: path.join(makeTempDir(), "registry.json"),
    });

    expect(malformedResult).toMatchObject({
      verdict: "corrupt",
      reason: "build-info-missing",
    });

    await noteRebuildGuardHealth(missingBuildInfoRoot, {
      fetchFn: makeFetch(registryBody({})),
      now: () => now,
      cacheFile: path.join(makeTempDir(), "registry.json"),
    });
    expect(noteMock).toHaveBeenCalledOnce();
    expect(noteMock.mock.calls[0]?.[0]).toContain("- Reason: build-info-missing");
  });

  it("returns inconclusive without emitting a note when fetch fails and no cache is present", async () => {
    const packageRoot = writePackageFixture();
    const fetchFn = vi.fn(async () => {
      throw new Error("offline");
    }) as FetchStub;
    const cacheFile = path.join(makeTempDir(), "registry.json");

    const result = await evaluateRebuildGuard({
      packageRoot,
      fetchFn,
      now: () => now,
      cacheFile,
    });

    expect(result).toMatchObject({
      verdict: "inconclusive",
      reason: "registry-unavailable",
    });

    await noteRebuildGuardHealth(packageRoot, {
      fetchFn,
      now: () => now,
      cacheFile,
    });
    expect(noteMock).not.toHaveBeenCalled();
  });

  it("skips fetch in offline mode and stays silent when local metadata is not enough", async () => {
    const packageRoot = writePackageFixture();
    const fetchFn = makeFetch(
      registryBody({
        "2026.4.15": "2026-04-16T12:00:00.000Z",
      }),
    );
    const cacheFile = path.join(makeTempDir(), "registry.json");

    const result = await evaluateRebuildGuard({
      packageRoot,
      fetchFn,
      now: () => now,
      offline: true,
      cacheFile,
    });

    expect(result).toMatchObject({
      verdict: "inconclusive",
      reason: "registry-unavailable",
    });
    expect(fetchFn).not.toHaveBeenCalled();

    await noteRebuildGuardHealth(packageRoot, {
      fetchFn,
      now: () => now,
      offline: true,
      cacheFile,
    });
    expect(noteMock).not.toHaveBeenCalled();
  });

  it("uses a fresh cache on the second call without fetching again", async () => {
    const packageRoot = writePackageFixture();
    const fetchFn = makeFetch(
      registryBody({
        "2026.4.15": "2026-04-16T12:00:00.000Z",
      }),
    );
    const cacheFile = path.join(makeTempDir(), "registry.json");

    const first = await evaluateRebuildGuard({
      packageRoot,
      fetchFn,
      now: () => now,
      cacheFile,
    });
    const second = await evaluateRebuildGuard({
      packageRoot,
      fetchFn,
      now: () => now,
      cacheFile,
    });

    expect(first.verdict).toBe("pristine");
    expect(second.verdict).toBe("pristine");
    expect(fetchFn).toHaveBeenCalledOnce();
  });
});

describe("noteRebuildGuardHealth", () => {
  it("emits only for rebuild, unreleased, and corrupt verdicts", async () => {
    const cases = [
      {
        verdict: "rebuild",
        packageRoot: writePackageFixture({ builtAt: "2026-04-19T12:00:00.000Z" }),
        fetchFn: makeFetch(registryBody({ "2026.4.15": "2026-04-16T12:00:00.000Z" })),
        shouldNote: true,
      },
      {
        verdict: "unreleased",
        packageRoot: writePackageFixture(),
        fetchFn: makeFetch(registryBody({ "2026.4.14": "2026-04-14T12:00:00.000Z" })),
        shouldNote: true,
      },
      {
        verdict: "corrupt",
        packageRoot: writePackageFixture({ omitBuildInfo: true }),
        fetchFn: makeFetch(registryBody({})),
        shouldNote: true,
      },
      {
        verdict: "pristine",
        packageRoot: writePackageFixture(),
        fetchFn: makeFetch(registryBody({ "2026.4.15": "2026-04-16T12:00:00.000Z" })),
        shouldNote: false,
      },
      {
        verdict: "inconclusive",
        packageRoot: writePackageFixture(),
        fetchFn: vi.fn(async () => {
          throw new Error("offline");
        }) as FetchStub,
        shouldNote: false,
      },
    ];

    for (const entry of cases) {
      noteMock.mockClear();
      await noteRebuildGuardHealth(entry.packageRoot, {
        fetchFn: entry.fetchFn,
        now: () => now,
        cacheFile: path.join(makeTempDir(), `${entry.verdict}-registry.json`),
      });

      if (entry.shouldNote) {
        expect(noteMock, entry.verdict).toHaveBeenCalledOnce();
      } else {
        expect(noteMock, entry.verdict).not.toHaveBeenCalled();
      }
    }
  });
});
