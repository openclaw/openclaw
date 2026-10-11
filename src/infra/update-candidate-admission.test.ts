import { ChildProcess, type SpawnOptions } from "node:child_process";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { UpdateAdmissionContext } from "./update-admission-contract.js";
import { runUpdateCandidateAdmission } from "./update-candidate-admission.js";
import { UPDATE_RUN_DIAGNOSTIC_LIMIT, UPDATE_RUN_TEXT_LIMIT } from "./update-run-limits.js";
import type { UpdateAdmissionVerdict } from "./update-run-schema.js";

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), signal: vi.fn(), tmpdir: vi.fn() }));
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: mocks.spawn,
}));
vi.mock("../process/kill-tree.js", () => ({ signalProcessTree: mocks.signal }));
vi.mock("./tmp-openclaw-dir.js", () => ({ resolvePreferredOpenClawTmpDir: mocks.tmpdir }));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
let root: string;
let context: UpdateAdmissionContext;
let contextPath: string;
let child: ChildProcess;
let childEnv: NodeJS.ProcessEnv;
let observedContext: unknown;
let observedModes: { file: number; directory: number };
let fixture: { code: number | null; stdout: string; stderr?: string; pending?: boolean };
let spawned: Promise<void>;
let resolveSpawned: () => void;

function admit(): UpdateAdmissionVerdict {
  return {
    protocol: 1,
    verdict: "admit",
    reasons: [],
    warnings: [{ code: "missing-plugin-load-path", message: "A custom plugin path is missing." }],
    facts: {
      candidateVersion: "2026.9.22",
      installedVersion: "2026.9.21",
      checks: [{ name: "config", status: "warn", detail: "A custom plugin path is missing." }],
    },
  };
}

function verdictJson(fields: Record<string, unknown> = {}, facts: Record<string, unknown> = {}) {
  const verdict = admit();
  return JSON.stringify({ ...verdict, ...fields, facts: { ...verdict.facts, ...facts } });
}

async function setMarker(marker: unknown): Promise<void> {
  await fs.writeFile(
    path.join(root, "package.json"),
    JSON.stringify({ version: "2026.9.22", openclaw: { updateAdmissionProtocol: marker } }),
  );
}

function run(overrides: Partial<Parameters<typeof runUpdateCandidateAdmission>[0]> = {}) {
  return runUpdateCandidateAdmission({ candidateRoot: root, context, env: {}, ...overrides });
}

beforeEach(async () => {
  vi.clearAllMocks();
  root = tempDirs.make("update-candidate-admission-");
  mocks.tmpdir.mockReturnValue(root);
  await fs.mkdir(path.join(root, "dist"));
  await fs.writeFile(path.join(root, "dist", "index.js"), "// candidate entry fixture");
  await setMarker(1);
  context = {
    protocol: 1,
    installation: {
      root: path.join(root, "live"),
      canonicalRoot: path.join(root, "canonical-live"),
      version: "2026.9.21",
      installKind: "package",
      packageManager: "npm",
      globalRoot: path.join(root, "global"),
    },
    target: {
      spec: "openclaw@2026.9.22",
      version: "2026.9.22",
      source: "registry",
      channel: "stable",
      tag: "latest",
    },
    request: {
      yes: true,
      noRestart: false,
      acceptCapabilities: false,
      json: true,
      requestedChannel: null,
    },
    run: { id: "admission-fixture-run" },
    supervisor: { version: "2026.9.21", host: "fixture-host", pid: 123 },
  };
  fixture = { code: 0, stdout: JSON.stringify(admit()) };
  contextPath = "";
  spawned = new Promise((resolve) => {
    resolveSpawned = resolve;
  });
  mocks.spawn.mockImplementation((_command: string, args: string[], options: SpawnOptions) => {
    child = new ChildProcess();
    Object.defineProperty(child, "pid", { value: 654 });
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    childEnv = options.env ?? {};
    contextPath = args[args.indexOf("--context") + 1]!;
    observedContext = JSON.parse(fsSync.readFileSync(contextPath, "utf8"));
    observedModes = {
      file: fsSync.statSync(contextPath).mode & 0o777,
      directory: fsSync.statSync(path.dirname(contextPath)).mode & 0o777,
    };
    resolveSpawned();
    if (!fixture.pending) {
      queueMicrotask(() => {
        if (fixture.stdout) {
          child.stdout?.emit("data", fixture.stdout);
        }
        if (fixture.stderr) {
          child.stderr?.emit("data", fixture.stderr);
        }
        child.emit("close", fixture.code);
      });
    }
    return child;
  });
  mocks.signal.mockImplementation((_pid, _signal, options) => {
    child.emit("close", null);
    options.onComplete();
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("runUpdateCandidateAdmission", () => {
  it.each(["unsupported", "forced"] as const)(
    "keeps %s candidate admission passive",
    async (mode) => {
      await setMarker(mode === "unsupported" ? "1" : 1);
      const result = await run({ admission: mode === "forced" ? "installed" : undefined });
      if (mode === "forced") {
        expect(result).toEqual({ owner: "installed", fallbackReason: "forced-installed" });
      } else {
        expect(result).toMatchObject({
          owner: "installed",
          fallbackReason: "unsupported-target",
          warning: { code: "update-admission-unsupported-target" },
        });
      }
      expect(mocks.spawn).not.toHaveBeenCalled();
    },
  );

  it.each(["known-version", "unknown-version", "artifact"] as const)(
    "launches the selected runner with private %s context and isolated runtime identity",
    async (target) => {
      if (target === "unknown-version") {
        context.target.version = null;
      } else if (target === "artifact") {
        const artifactUrl = new URL("https://registry.example/package.tgz");
        artifactUrl.username = "fixture-user";
        artifactUrl.password = "fixture-password";
        artifactUrl.searchParams.set("token", "fixture-token");
        context.target.source = "artifact";
        context.target.spec = artifactUrl.href;
        context.target.tag = context.target.spec;
      }
      const env = {
        HOME: path.join(root, "home"),
        OPENCLAW_HOME: path.join(root, "openclaw-home"),
        OPENCLAW_STATE_DIR: path.join(root, "live-state"),
        OPENCLAW_CONFIG_PATH: path.join(root, "live-config.json"),
        OPENCLAW_PROFILE: "work",
        OPENCLAW_UPDATE_IN_PROGRESS: "1",
        OPENCLAW_UPDATE_RUN_ID: "inherited-run",
        OPENCLAW_UPDATE_RUN_HANDOFF: "1",
        OPENCLAW_UPDATE_POST_CORE: "1",
        OPENCLAW_UPDATE_POST_CORE_RESULT_PATH: "inherited-result",
        OPENCLAW_UPDATE_PARENT_ALLOWS_GATEWAY_ACTIVATION: "1",
        OPENCLAW_UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE: "1",
        OPENCLAW_UPDATE_EXECUTOR_GRANT: "inherited-grant",
        OPENCLAW_CONTROL_PLANE_UPDATE_SENTINEL_META: "inherited-sentinel",
        OPENCLAW_GATEWAY_SERVICE_PID: "789",
        OPENCLAW_SYSTEMD_UNIT: "live.service",
        OPENCLAW_COMPATIBILITY_HOST_VERSION: "2026.9.1",
        openclaw_compatibility_host_version: "2026.9.2",
        OPENCLAW_DEV_SOURCE_ROOT: path.join(root, "old-source"),
        openclaw_dev_source_root: path.join(root, "old-source-alias"),
        OPENCLAW_VERSION: "2026.9.3",
        openclaw_version: "2026.9.4",
        OPENCLAW_BUNDLED_PLUGINS_DIR: path.join(root, "old-plugins"),
        openclaw_bundled_plugins_dir: path.join(root, "old-plugins-alias"),
        NODE_COMPILE_CACHE: path.join(root, "live-cache"),
        node_compile_cache: path.join(root, "live-cache-alias"),
        NODE_DISABLE_COMPILE_CACHE: "0",
        node_disable_compile_cache: "0",
        OPENCLAW_NO_RESPAWN: "0",
        openclaw_no_respawn: "0",
        PROVIDER_API_KEY: "synthetic-provider-key",
      };
      const result = await run({ env, nodeRunner: "/selected/node" });
      expect(result).toEqual({ owner: "candidate", verdict: admit() });
      if (target === "artifact") {
        const serialized = JSON.stringify(observedContext);
        expect(serialized).not.toContain("fixture-password");
        expect(serialized).not.toContain("fixture-token");
        expect(serialized).toContain("registry.example/package.tgz");
      } else {
        expect(observedContext).toEqual(context);
      }
      if (process.platform !== "win32") {
        expect(observedModes).toEqual({ file: 0o600, directory: 0o700 });
      }
      expect(mocks.spawn).toHaveBeenCalledWith(
        "/selected/node",
        [path.join(root, "dist", "index.js"), "update", "admit", "--context", contextPath],
        expect.objectContaining({
          cwd: root,
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
        }),
      );
      expect(childEnv).toEqual({
        HOME: env.HOME,
        OPENCLAW_HOME: env.OPENCLAW_HOME,
        OPENCLAW_STATE_DIR: env.OPENCLAW_STATE_DIR,
        OPENCLAW_CONFIG_PATH: env.OPENCLAW_CONFIG_PATH,
        OPENCLAW_PROFILE: "work",
        NODE_DISABLE_COMPILE_CACHE: "1",
        OPENCLAW_DEV_SOURCE_ROOT: root,
        ...(context.target.version === null ? {} : { OPENCLAW_VERSION: context.target.version }),
        OPENCLAW_NO_RESPAWN: "1",
        PROVIDER_API_KEY: "synthetic-provider-key",
      });
      expect(env.OPENCLAW_UPDATE_RUN_ID).toBe("inherited-run");
      expect(env.OPENCLAW_DEV_SOURCE_ROOT).toBe(path.join(root, "old-source"));
      expect(env.NODE_COMPILE_CACHE).toBe(path.join(root, "live-cache"));
      await expect(fs.access(path.dirname(contextPath))).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it.each([false, true])(
    "preserves candidate refusals and bounds diagnostics (oversized=%s)",
    async (oversized) => {
      const message = oversized ? "diagnostic ".repeat(500) : "The config is invalid.";
      const reply: UpdateAdmissionVerdict = {
        ...admit(),
        verdict: "refuse",
        reasons: [
          {
            code: "invalid-config",
            message,
            nextAction: oversized ? message : "Repair the config.",
          },
          { code: "database-schema-preflight", message: "The target cannot read this database." },
        ],
        warnings: oversized
          ? [
              { code: "x".repeat(81), message },
              ...Array.from({ length: 40 }, (_, index) => ({ code: `warning-${index}`, message })),
            ]
          : admit().warnings,
        facts: {
          ...admit().facts,
          checks: [{ name: "config", status: "refuse", ...(oversized ? { detail: message } : {}) }],
        },
      };
      fixture = { code: 3, stdout: JSON.stringify(reply) };
      const result = await run();
      await expect(fs.access(contextPath)).rejects.toMatchObject({ code: "ENOENT" });
      if (!oversized) {
        expect(result).toEqual({ owner: "candidate", verdict: reply });
        return;
      }
      expect(result.owner).toBe("candidate");
      expect(result.verdict?.verdict).toBe("refuse");
      expect(result.verdict?.reasons.map((reason) => reason.code)).toEqual(
        reply.reasons.map((reason) => reason.code),
      );
      expect(result.verdict?.warnings).toHaveLength(UPDATE_RUN_DIAGNOSTIC_LIMIT);
      expect(result.verdict?.warnings[0]?.code).toBe("warning-0");
      expect(
        result.verdict?.warnings.every(
          (warning) => warning.message.length <= UPDATE_RUN_TEXT_LIMIT,
        ),
      ).toBe(true);
      expect(result.verdict?.facts.checks[0]).toMatchObject({
        name: "config",
        status: "refuse",
      });
      expect(result.verdict?.facts.checks[0]?.detail?.length).toBeLessThanOrEqual(
        UPDATE_RUN_TEXT_LIMIT,
      );
      for (const reason of result.verdict?.reasons ?? []) {
        expect(reason.message.length).toBeLessThanOrEqual(UPDATE_RUN_TEXT_LIMIT);
      }
      expect(result.verdict?.reasons[0]?.nextAction?.length).toBeLessThanOrEqual(
        UPDATE_RUN_TEXT_LIMIT,
      );
    },
  );

  it.each([
    ["internal error", 2, verdictJson(), "exit-2"],
    ["crash", null, "", "crash"],
    ["malformed JSON", 0, "not a verdict", "malformed-json"],
    ["protocol mismatch", 0, verdictJson({ protocol: 2 }), "protocol-mismatch"],
    ["wrong shape", 0, JSON.stringify({ protocol: 1, verdict: "admit" }), "invalid-verdict"],
    ["wrong exit", 3, verdictJson(), "invalid-verdict"],
    ["empty refusal", 3, verdictJson({ verdict: "refuse" }), "invalid-verdict"],
    [
      "duplicate check",
      0,
      verdictJson({}, { checks: [...admit().facts.checks, ...admit().facts.checks] }),
      "invalid-verdict",
    ],
    ["oversized output", 0, "x".repeat(1024 * 1024 + 1), "output-limit"],
    [
      "too many reasons",
      3,
      verdictJson({
        verdict: "refuse",
        reasons: Array.from({ length: 33 }, () => ({
          code: "invalid-config",
          message: "Invalid config.",
        })),
      }),
      "invalid-verdict",
    ],
    [
      "too many checks",
      0,
      verdictJson(
        {},
        {
          checks: Array.from({ length: 33 }, (_, index) => ({
            name: `check-${index}`,
            status: "ok",
          })),
        },
      ),
      "invalid-verdict",
    ],
    [
      "oversized reason identity",
      3,
      verdictJson({
        verdict: "refuse",
        reasons: [{ code: "x".repeat(81), message: "Invalid config." }],
      }),
      "invalid-verdict",
    ],
    [
      "oversized multibyte check identity",
      0,
      verdictJson({}, { checks: [{ name: "é".repeat(65), status: "ok" }] }),
      "invalid-verdict",
    ],
    [
      "oversized candidate version",
      0,
      verdictJson({}, { candidateVersion: "v".repeat(129) }),
      "invalid-verdict",
    ],
    [
      "irreducible history metadata",
      0,
      verdictJson(
        {},
        {
          checks: Array.from({ length: 8 }, (_, index) => ({
            name: `${index}${"c".repeat(127)}`,
            status: "ok",
          })),
        },
      ),
      "invalid-verdict",
    ],
  ] as const)(
    "falls back after %s and retains the last redacted stderr diagnostic",
    async (_name, code, stdout, reason) => {
      fixture = {
        code,
        stdout,
        stderr: "earlier diagnostic\ncannot inspect token=synthetic-secret\n",
      };
      const result = await run({ env: { API_TOKEN: "synthetic-secret" } });
      expect(result).toMatchObject({
        owner: "installed",
        fallbackReason: reason,
        warning: { code: "update-admission-fallback" },
      });
      expect(result.warning?.message).toContain("cannot inspect");
      expect(result.warning?.message).not.toContain("synthetic-secret");
      expect(result.warning?.message).not.toContain("earlier diagnostic");
      expect(result.verdict).toBeUndefined();
      await expect(fs.access(contextPath)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it("bounds admission and terminates its process tree before context cleanup", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    fixture.pending = true;
    const result = run({ timeoutMs: 1_000 });
    await spawned;
    await vi.advanceTimersByTimeAsync(900);
    expect(await result).toMatchObject({
      owner: "installed",
      fallbackReason: "timeout",
      warning: { code: "update-admission-fallback" },
    });
    expect(mocks.signal.mock.calls.map((call) => call[1])).toEqual(["SIGTERM", "SIGKILL"]);
    await expect(fs.access(contextPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("cleans the private context when spawning the candidate fails", async () => {
    const spawn = mocks.spawn.getMockImplementation()!;
    mocks.spawn.mockImplementationOnce((...args) => {
      fixture.pending = true;
      spawn(...args);
      throw new Error("Cannot launch selected Node runner");
    });
    expect(await run()).toMatchObject({
      owner: "installed",
      fallbackReason: "internal-error",
      warning: {
        code: "update-admission-fallback",
        message: expect.stringContaining("Cannot launch selected Node runner"),
      },
    });
    await expect(fs.access(contextPath)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
