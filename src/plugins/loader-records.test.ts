import { afterEach, expect, it, vi } from "vitest";
import { resolveInstallMetadata } from "./candidate-install-owner.js";
import { createPluginRecord, recordPluginError } from "./loader-records.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";

function recordError(
  error: Error,
  origin: "global" | "bundled",
  missingDependencyHint?: string,
  damagedNativeCaptureReinstall?: { packageName: string; packageVersion: string },
) {
  const id = origin === "global" ? "broken-plugin" : "discord";
  const record = createPluginRecord({
    id,
    source: `/tmp/${id}/index.js`,
    origin,
    packageName: "@untrusted/discovery-metadata",
    packageVersion: "0.0.0",
    enabled: true,
    configSchema: false,
  });
  recordPluginError({
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    registry: createEmptyPluginRegistry(),
    record,
    seenIds: new Map(),
    phase: "load",
    error,
    missingDependencyHint,
    damagedNativeCaptureReinstall,
  });
  return record.error;
}

it("suggests exact-version reinstall for a missing managed native capture", () => {
  const error = new Error(
    "Cannot capture plugin source /state/tmp/plugin-captures/run/native/admission-id/content/README.md",
    {
      cause: Object.assign(new Error("missing capture bytes"), { code: "ENOENT" }),
    },
  );

  expect(
    recordError(error, "global", undefined, {
      packageName: "@openclaw/codex",
      packageVersion: "2026.10.9",
    }),
  ).toContain(
    "reinstall it with `openclaw plugins install npm:@openclaw/codex@2026.10.9 --force --pin --no-enable`",
  );
});

it.each([
  {
    name: "capture without retained install provenance",
    error: new Error(
      "Cannot capture plugin source /state/tmp/plugin-captures/run/native/admission-id/content/README.md",
      { cause: Object.assign(new Error("missing capture bytes"), { code: "ENOENT" }) },
    ),
    reinstall: undefined,
  },
  {
    name: "ordinary missing plugin source",
    error: new Error("Cannot capture plugin source /plugins/codex/index.js", {
      cause: Object.assign(new Error("missing source"), { code: "ENOENT" }),
    }),
    reinstall: { packageName: "@openclaw/codex", packageVersion: "2026.10.9" },
  },
  {
    name: "non-missing managed capture failure",
    error: new Error(
      "Cannot capture plugin source /state/tmp/plugin-captures/run/native/admission-id/content/README.md",
      { cause: Object.assign(new Error("permission denied"), { code: "EACCES" }) },
    ),
    reinstall: { packageName: "@openclaw/codex", packageVersion: "2026.10.9" },
  },
  {
    name: "unsafe package metadata",
    error: new Error(
      "Cannot capture plugin source /state/tmp/plugin-captures/run/native/admission-id/content/README.md",
      { cause: Object.assign(new Error("missing capture bytes"), { code: "ENOENT" }) },
    ),
    reinstall: { packageName: "@openclaw/codex;echo", packageVersion: "2026.10.9" },
  },
  {
    name: "hostile error stringification",
    error: new Error("capture failed", {
      cause: Object.assign(new Error("missing capture bytes"), {
        code: "ENOENT",
        toString: () => {
          throw new Error("stringification failed");
        },
      }),
    }),
    reinstall: { packageName: "@openclaw/codex", packageVersion: "2026.10.9" },
  },
])("does not suggest reinstall for $name", ({ error, reinstall }) => {
  expect(recordError(error, "global", undefined, reinstall)).not.toContain(
    "openclaw plugins install",
  );
});

it("derives reinstall identity only from an integrity-backed managed npm install", () => {
  const installs = {
    codex: {
      source: "npm" as const,
      integrity: "sha512-fixture",
      resolvedName: "@openclaw/codex",
      resolvedVersion: "2026.10.9",
    },
    editable: {
      source: "path" as const,
      resolvedName: "@openclaw/editable",
      resolvedVersion: "1.0.0",
    },
  };

  expect(resolveInstallMetadata("global", "codex", installs).reinstall).toEqual({
    packageName: "@openclaw/codex",
    packageVersion: "2026.10.9",
  });
  expect(resolveInstallMetadata("global", "editable", installs).reinstall).toBeUndefined();
  expect(resolveInstallMetadata("bundled", "codex", installs).reinstall).toBeUndefined();
  expect(resolveInstallMetadata("global", "missing", installs).reinstall).toBeUndefined();
});

afterEach(() => vi.unstubAllEnvs());

function throwingAccessor(error: Error, property: "cause" | "code") {
  return Object.defineProperty(error, property, {
    get(): never {
      throw new Error(`${property} exploded`);
    },
  });
}

it.each([
  { diagnostics: "", expected: "Error: boom" },
  { diagnostics: "1", expected: "Error: boom\n    at plugin-entry.ts:1:1" },
])("uses lifecycle tracing for loader error stacks", ({ diagnostics, expected }) => {
  vi.stubEnv("OPENCLAW_PLUGIN_LIFECYCLE_TRACE", diagnostics);
  const error = new Error("boom");
  error.stack = "Error: boom\n    at plugin-entry.ts:1:1";

  expect(recordError(error, "global")).toBe(expected);
});

it.each([
  {
    name: "names the install path when a missing module sits on the error cause",
    error: new Error("import failed", {
      cause: Object.assign(new Error("Cannot find module 'discord-api-types/v10'"), {
        code: "MODULE_NOT_FOUND",
      }),
    }),
    expected: "install @openclaw/discord (Error: import failed)",
  },
  {
    name: "keeps unrelated failures verbatim",
    error: new Error("boom"),
    expected: "Error: boom",
  },
  {
    name: "survives a nested throwing code accessor without rethrowing",
    error: new Error("wrapped", { cause: throwingAccessor(new Error("nested"), "code") }),
    expected: "Error: wrapped",
  },
  {
    name: "survives a throwing cause accessor without rethrowing",
    error: throwingAccessor(new Error("hostile"), "cause"),
    expected: "Error: hostile",
  },
])("$name", ({ error, expected }) => {
  expect(recordError(error, "bundled", "install @openclaw/discord")).toBe(expected);
});
