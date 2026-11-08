import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parse } from "yaml";
import {
  createReleaseGhReadRetry,
  isReleaseGhRestRead,
  releaseGhResponse,
} from "../../scripts/lib/release-gh-read-retry.mjs";
import {
  authenticatePreparedNpmArtifact,
  preparedNpmArtifactName,
} from "../../scripts/plugin-npm-prepared-release.mjs";
import { downloadArtifactZip, runReleaseCiGh } from "../../scripts/release-ci-summary.mjs";
import {
  revalidateQualificationAdmissionAuthority,
  runQualificationAdmissionGh,
} from "../../scripts/release-qualification-admission.mjs";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { candidatePublicationFixture } from "./candidate-publication.test-support.js";
import { fixture } from "./release-qualification-admission.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const args = ["api", "repos/openclaw/openclaw/actions/runs/42"];
const start = Date.parse("2026-11-08T03:00:00Z");
function failure(status: number, headers = "", message = "forbidden") {
  return Object.assign(new Error(message), {
    stderr: "gh: " + message + " (HTTP " + status + ")",
    stdout: "HTTP/2.0 " + status + " Error\r\n" + headers + "\r\n" + JSON.stringify({ message }),
  });
}
const refuse = (error: unknown): never => {
  throw error;
};
afterEach(() => vi.restoreAllMocks());

it("captures response headers and preserves binary archive bytes", () => {
  const archive = Buffer.from([0x50, 0x4b, 0, 0xff, 0x80]);
  const response = Buffer.concat([
    Buffer.from("HTTP/2.0 200 OK\r\nContent-Type: application/zip\r\n\r\n"),
    archive,
  ]);
  expect(releaseGhResponse(response)).toEqual({
    status: 200,
    headers: { "content-type": "application/zip" },
    body: archive,
  });
  expect(releaseGhResponse('{"id":42}').body).toBe('{"id":42}');
});

it.each([
  ["Retry-After seconds", "Retry-After: 90\r\n", 90_500],
  ["Retry-After date", "Retry-After: Sun, 08 Nov 2026 03:02:00 GMT\r\n", 120_500],
  [
    "primary reset",
    "X-RateLimit-Remaining: 0\r\nX-RateLimit-Reset: " + (start + 180_000) / 1000 + "\r\n",
    180_500,
  ],
  [
    "both floors",
    "Retry-After: 90\r\nX-RateLimit-Remaining: 0\r\nX-RateLimit-Reset: " +
      (start + 180_000) / 1000 +
      "\r\n",
    180_500,
  ],
  ["invalid header fallback", "Retry-After: invalid\r\n", 60_500],
])("honors %s without negative jitter", (_label, headers, expected) => {
  const retry = createReleaseGhReadRetry(args, { now: () => start, random: () => 0.5 });
  expect(retry.delay(failure(403, headers), refuse)).toBe(expected);
});

it("does not treat a nonquota HTTP 403 as a transient network failure", () => {
  const error = Object.assign(failure(403, "X-RateLimit-Remaining: 42\r\n"), {
    code: "ECONNRESET",
    stderr: "",
    message: "network error",
  });
  const transient = vi.fn(() => 2_000);
  const retry = createReleaseGhReadRetry(args);
  expect(() => retry.delay(error, transient)).toThrow(error);
  expect(transient).not.toHaveBeenCalled();
});

it("refuses a successful response arriving after the total deadline", () => {
  let now = start;
  const execute = vi.fn(() => {
    now += 100_001;
    return '{"id":42}';
  });
  expect(() =>
    runReleaseCiGh(args, { execFileSyncImpl: execute, now: () => now, budgetMs: 100_000 }),
  ).toThrow(/deadline/);
  expect(execute).toHaveBeenCalledOnce();
});

it("backs off unambiguous headerless quota errors, bounded to three retries", () => {
  const retry = createReleaseGhReadRetry(args, { now: () => start, random: () => 0 });
  const error = failure(403, "", "API rate limit exceeded for installation ID 1");
  expect([0, 1, 2].map(() => retry.delay(error, refuse))).toEqual([60_000, 120_000, 240_000]);
  expect(() => retry.delay(error, refuse)).toThrow(error);
});

it("refuses reset beyond deadline without early retry, then bounds remaining execution", () => {
  let now = start;
  const retry = createReleaseGhReadRetry(args, {
    now: () => now,
    budgetMs: 100_000,
    random: () => 0,
  });
  const error = failure(
    403,
    "X-RateLimit-Remaining: 0\r\nX-RateLimit-Reset: " + (start + 180_000) / 1000 + "\r\n",
  );
  expect(() => retry.delay(error, refuse)).toThrow(/deadline/);
  now += 90_000;
  expect(retry.timeout(60_000)).toBe(10_000);
  now += 10_000;
  expect(() => retry.timeout(60_000)).toThrow(/deadline/);
});

it.each([
  ["api", "graphql"],
  ["api", "repos/openclaw/openclaw/issues", "-f", "title=x"],
  [...args, "--method", "POST"],
  [...args, "--method=POST"],
  [...args, "--method", "GET", "--input", "request.json"],
  [...args, "--method", "GET", "-F", "field=value"],
  [...args, "--paginate"],
  [...args, "-H", "X-HTTP-Method-Override: POST"],
  ["run", "rerun", "42"],
])("never retries mutation-shaped or unknown commands %j", (...command) => {
  expect(isReleaseGhRestRead(command)).toBe(false);
  const retry = createReleaseGhReadRetry(command);
  const error = failure(429, "Retry-After: 60\r\n");
  expect(retry.args).toEqual(command);
  expect(() => retry.delay(error, refuse)).toThrow(error);
});

for (const adapter of ["evidence", "admission"] as const) {
  describe(adapter + " adapter", () => {
    function invoke(read: ReturnType<typeof vi.fn>, params = {}) {
      return adapter === "evidence"
        ? runReleaseCiGh(args, { execFileSyncImpl: read, ...params })
        : runQualificationAdmissionGh([...args, "--method", "GET"], {
            execPlainGhImpl: read,
            ...params,
          });
    }
    it("retries quota in the real adapter and returns body only", () => {
      const wait = vi.spyOn(Atomics, "wait").mockReturnValue("timed-out");
      const read = vi
        .fn()
        .mockImplementationOnce(() => {
          throw failure(403, "Retry-After: 90\r\n");
        })
        .mockReturnValue('HTTP/2.0 200 OK\r\nContent-Type: application/json\r\n\r\n{"id":42}');
      expect(invoke(read, { now: () => start, random: () => 0 })).toBe('{"id":42}');
      expect(read).toHaveBeenCalledTimes(2);
      expect(wait.mock.calls[0]?.[3]).toBe(90_000);
      expect(
        read.mock.calls.every((call) => call[adapter === "evidence" ? 1 : 0].includes("--include")),
      ).toBe(true);
    });
    it("refuses an ordinary authorization 403 immediately", () => {
      const wait = vi.spyOn(Atomics, "wait").mockReturnValue("timed-out");
      const error = failure(
        403,
        "X-RateLimit-Remaining: 42\r\n",
        "Resource not accessible by integration",
      );
      const read = vi.fn(() => {
        throw error;
      });
      expect(() => invoke(read)).toThrow(error);
      expect(read).toHaveBeenCalledOnce();
      expect(wait).not.toHaveBeenCalled();
    });
    it("never retries POST even for quota", () => {
      const error = failure(429, "Retry-After: 60\r\n");
      const read = vi.fn(() => {
        throw error;
      });
      const command = [...args, "--method", "POST"];
      expect(() =>
        adapter === "evidence"
          ? runReleaseCiGh(command, { execFileSyncImpl: read })
          : runQualificationAdmissionGh(command, { execPlainGhImpl: read }),
      ).toThrow(error);
      expect(read).toHaveBeenCalledOnce();
    });
  });
}

it("caps only the publish matrix and leaves fresh authorization before npm writes", () => {
  const text = readFileSync(".github/workflows/plugin-npm-release.yml", "utf8");
  const workflow = parse(text);
  expect(workflow.jobs.publish_plugins_npm.strategy["max-parallel"]).toBe(4);
  expect(workflow.jobs.publish_plugins_npm.strategy["fail-fast"]).toBe(false);
  const steps = workflow.jobs.publish_plugins_npm.steps;
  const writes = steps.filter((step: { run?: string }) =>
    /npm (?:publish|dist-tag add)/u.test(step.run ?? ""),
  );
  expect(writes.length).toBeGreaterThan(0);
  for (const step of writes) {
    expect(step.run).toContain("plugin-npm-prepared-release.mjs authorize");
    expect(step.run.indexOf("plugin-npm-prepared-release.mjs authorize")).toBeLessThan(
      step.run.search(/npm (?:publish|dist-tag add)/u),
    );
  }
});

it.each(["permission", "tag", "attempt", "digest"])(
  "rejects %s revoked while quota recovery waits",
  (fault) => {
    const f = fixture(true);
    const admission = f.verify();
    let blocked = true;
    const execute = vi.fn((command: string[]) => {
      if (blocked) {
        blocked = false;
        throw failure(403, "Retry-After: 60\r\n");
      }
      return f.runGh(command);
    });
    const sleep = vi.fn(() => {
      if (fault === "permission") f.authority.permission = "read";
      if (fault === "tag") f.authority.tagSha = "f".repeat(40);
      if (fault === "attempt") f.run.run_attempt = 2;
      if (fault === "digest") f.metadata.digest = "sha256:" + "f".repeat(64);
    });
    expect(() =>
      revalidateQualificationAdmissionAuthority({
        descriptor: f.descriptor,
        admission,
        runGh: (command: string[]) =>
          runQualificationAdmissionGh(command, {
            execPlainGhImpl: execute,
            sleep,
            now: () => start,
            random: () => 0,
          }),
      }),
    ).toThrow();
    expect(sleep).toHaveBeenCalledOnce();
    expect(
      execute.mock.calls.filter(
        ([command]) => command[1] === "repos/openclaw/openclaw/actions/artifacts/70",
      ),
    ).toHaveLength(2);
  },
);

// Exercise the real synchronous transport below a caller wrapper, with distinct
// actor/triggering actor identities. Earlier JSON is a snapshot, not a live alias.
function lateAuthorityFixture() {
  const f = fixture(true);
  const verified = f.verify();
  const trigger = { id: 92, login: "triggering-operator", type: "User" };
  f.run.triggering_actor = trigger;
  const admission = { ...verified, triggeringOperator: { id: trigger.id, login: trigger.login } };
  let triggerPermission = "write";
  const permissionPath = "repos/openclaw/openclaw/collaborators/";
  const read = (command: string[]) =>
    command[1] === permissionPath + trigger.login + "/permission"
      ? JSON.stringify({ permission: triggerPermission, user: trigger })
      : f.runGh(command);
  return {
    ...f,
    admission,
    read,
    revokeTrigger: () => {
      triggerPermission = "read";
    },
    operatorPath: permissionPath + f.actor.login + "/permission",
    triggerPath: permissionPath + trigger.login + "/permission",
  };
}

it.each(["actor", "triggering actor"])(
  "rejects earlier mutable authority changed while the late %s permission waits",
  (late) => {
    // Earlier tag/attempt/artifact/job reads must not survive the permission wait.
    // Also recheck both distinct operator grants, including already-read grants.
    for (const fault of ["tag", "attempt", "digest", "jobs", "actor", "trigger"] as const) {
      const f = lateAuthorityFixture();
      const target = late === "actor" ? f.operatorPath : f.triggerPath;
      let blocked = true;
      const execute = vi.fn((command: string[]) => {
        if (blocked && command[1] === target) {
          blocked = false;
          throw failure(429, "Retry-After: 60\r\n");
        }
        return f.read(command);
      });
      const sleep = vi.fn(() => {
        if (fault === "tag") f.authority.tagSha = "f".repeat(40);
        if (fault === "attempt") f.run.run_attempt = 2;
        if (fault === "digest") f.metadata.digest = "sha256:" + "f".repeat(64);
        if (fault === "jobs") f.jobs.jobs[0].conclusion = "failure";
        if (fault === "actor") f.authority.permission = "read";
        if (fault === "trigger") f.revokeTrigger();
      });
      expect(
        () =>
          revalidateQualificationAdmissionAuthority({
            descriptor: f.descriptor,
            admission: f.admission,
            runGh: (command: string[]) =>
              runQualificationAdmissionGh(command, {
                execPlainGhImpl: execute,
                sleep,
                now: () => start,
                random: () => 0,
              }),
          }),
        fault,
      ).toThrow();
      expect(sleep, fault).toHaveBeenCalledOnce();
      expect(
        execute.mock.calls.filter(
          ([command]) => command[1] === "repos/openclaw/openclaw/actions/artifacts/70",
        ),
        fault,
      ).toHaveLength(2);
    }
  },
);

it.each(["artifact", "jobs", "tag", "attempt", "actor", "trigger"])(
  "restarts all mutable reads after a quota wait at %s, then permits unchanged authority",
  (at) => {
    const f = lateAuthorityFixture();
    const paths = [
      "repos/openclaw/openclaw/actions/artifacts/70",
      "repos/openclaw/openclaw/actions/runs/40/attempts/1/jobs?per_page=100",
      "repos/openclaw/openclaw/git/ref/tags/" + f.producer.workflowHeadBranch,
      "repos/openclaw/openclaw/actions/runs/40/attempts/1",
      f.operatorPath,
      f.triggerPath,
    ];
    const target = paths[["artifact", "jobs", "tag", "attempt", "actor", "trigger"].indexOf(at)];
    let blocked = true;
    const execute = vi.fn((command: string[]) => {
      if (blocked && command[1] === target) {
        blocked = false;
        throw failure(429, "Retry-After: 60\r\n");
      }
      return f.read(command);
    });
    const sleep = vi.fn();
    expect(() =>
      revalidateQualificationAdmissionAuthority({
        descriptor: f.descriptor,
        admission: f.admission,
        runGh: (command: string[]) =>
          runQualificationAdmissionGh(command, {
            execPlainGhImpl: execute,
            sleep,
            now: () => start,
            random: () => 0,
          }),
      }),
    ).not.toThrow();
    expect(sleep).toHaveBeenCalledOnce();
    expect(execute.mock.calls.slice(-6).map(([command]) => command[1])).toEqual(paths);
  },
);

it.each(["attempts", "deadline", "late success"])(
  "bounds the whole authority pass by shared %s rather than resetting at each GET",
  (bound) => {
    const f = lateAuthorityFixture();
    let now = start;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    let waits = 0;
    const execute = vi.fn((command: string[], options: { timeout: number }) => {
      if (command[1] === f.triggerPath && (bound !== "late success" || waits === 0)) {
        // A second 540s floor cannot fit the remaining overall 600s deadline.
        throw failure(429, bound === "deadline" ? "Retry-After: 540\r\n" : "");
      }
      if (command[1] === f.triggerPath && bound === "late success") {
        expect(options.timeout).toBe(60_000);
        now = start + 600_001;
      }
      return f.read(command);
    });
    const sleep = vi.fn((ms: number) => {
      now += ms;
      waits += 1;
    });
    expect(() =>
      revalidateQualificationAdmissionAuthority({
        descriptor: f.descriptor,
        admission: f.admission,
        runGh: (command: string[]) =>
          runQualificationAdmissionGh(command, {
            execPlainGhImpl: execute,
            sleep,
            now: () => now,
            random: () => 0,
          }),
      }),
    ).toThrow(bound === "attempts" ? /forbidden/ : /deadline/);
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual(
      bound === "attempts"
        ? [60_000, 120_000, 240_000]
        : bound === "deadline"
          ? [540_000]
          : [60_000],
    );
  },
);

it.each(["JSON", "ZIP"])("reserves header headroom but retains the %s body limit", (kind) => {
  const zip = kind === "ZIP";
  const limit = zip ? 512 * 1024 : 256 * 1024 * 4;
  const command = zip ? ["api", "repos/openclaw/openclaw/actions/artifacts/70/zip"] : args;
  const header = Buffer.from("HTTP/2.0 200 OK\r\nX-Test: " + "x".repeat(4096) + "\r\n\r\n");
  let body = zip ? Buffer.alloc(limit, 0x80) : Buffer.from('"' + "x".repeat(limit - 2) + '"');
  const execute = vi.fn((_command: string[], options: { maxBuffer: number }) => {
    const response = Buffer.concat([header, body]);
    if (response.length > options.maxBuffer) throw new Error("stdout maxBuffer length exceeded");
    return zip ? response : response.toString("utf8");
  });
  expect(runQualificationAdmissionGh(command, { execPlainGhImpl: execute })).toEqual(
    zip ? body : body.toString("utf8"),
  );
  body = Buffer.concat([body, Buffer.from("x")]);
  expect(() => runQualificationAdmissionGh(command, { execPlainGhImpl: execute })).toThrow(
    /Oversized/,
  );
});

it("retains old CLI binary fallback with exact archive bytes and quota recovery", () => {
  const archive = Buffer.from([0x50, 0x4b, 0, 0xff]);
  const execute = vi
    .fn()
    .mockImplementationOnce(() => {
      throw Object.assign(new Error("unsupported"), {
        stderr: "unknown flag: --allow-escape-sequences",
      });
    })
    .mockImplementationOnce(() => {
      throw failure(429, "Retry-After: 60\r\n");
    })
    .mockReturnValue(
      Buffer.concat([
        Buffer.from("HTTP/2.0 200 OK\r\nContent-Type: application/zip\r\n\r\n"),
        archive,
      ]),
    );
  const sleep = vi.fn();
  expect(
    runQualificationAdmissionGh(["api", "repos/openclaw/openclaw/actions/artifacts/70/zip"], {
      execPlainGhImpl: execute,
      sleep,
      now: () => start,
      random: () => 0,
    }),
  ).toEqual(archive);
  expect(execute.mock.calls[0]?.[0]).toContain("--allow-escape-sequences");
  expect(execute.mock.calls[1]?.[0]).not.toContain("--allow-escape-sequences");
  expect(execute.mock.calls[2]?.[0]).not.toContain("--allow-escape-sequences");
  expect(sleep).toHaveBeenCalledWith(60_000);
});

it("retries bounded archive GETs without writing headers or failed partial output", () => {
  const root = tempDirs.make("quota-archive-");
  const destination = join(root, "manifest.zip");
  writeFileSync(destination, "old bytes");
  const archive = Buffer.from([0x50, 0x4b, 0, 0xff]);
  const error = failure(403, "Retry-After: 60\r\n");
  const execute = vi
    .fn()
    .mockImplementationOnce(() => {
      throw error;
    })
    .mockReturnValue(
      Buffer.concat([
        Buffer.from("HTTP/2.0 200 OK\r\nContent-Type: application/zip\r\n\r\n"),
        archive,
      ]),
    );
  const sleep = vi.fn(() => expect(readFileSync(destination, "utf8")).toBe("old bytes"));
  downloadArtifactZip("70", destination, archive.length, "openclaw/openclaw", {
    execFileSyncImpl: execute,
    sleep,
    now: () => start,
    random: () => 0,
  });
  expect(readFileSync(destination)).toEqual(archive);
  expect(execute).toHaveBeenCalledTimes(2);
  expect(sleep).toHaveBeenCalledWith(60_000);
  expect(execute.mock.calls[0]?.[1]).toEqual([
    "api",
    "repos/openclaw/openclaw/actions/artifacts/70/zip",
    "--include",
  ]);
});

it("accounts for admission reads during a full prepared publisher authentication fixture", async () => {
  const f = candidatePublicationFixture();
  const artifact = {
    repository: f.repository,
    runId: 101,
    runAttempt: 2,
    workflowPath: ".github/workflows/plugin-npm-release.yml",
    workflowEvent: "workflow_dispatch",
    workflowHeadBranch: f.branch,
    workflowSha: f.q,
    artifactId: 9001,
    artifactDigest: "sha256:" + "d".repeat(64),
    artifactSizeBytes: 1024,
    artifactName: "",
  };
  artifact.artifactName = preparedNpmArtifactName(f.q, artifact);
  Object.assign(f.manifest.publicationArtifacts, { pluginNpm: artifact });
  const original = f.admission.runGh;
  const restReads: string[] = [];
  f.admission.runGh = (command: string[]) => {
    restReads.push(command[1]!);
    return original(command);
  };
  const methodReads: Record<string, number> = {};
  const evidenceClient = Object.fromEntries(
    Object.entries(f.client).map(([name, value]) => [
      name,
      typeof value !== "function"
        ? value
        : (...params: unknown[]) => {
            methodReads[name] = (methodReads[name] ?? 0) + 1;
            return name === "getWorkflowSource" &&
              params[1] === ".github/workflows/plugin-npm-release.yml"
              ? "name: immutable Q policy"
              : Reflect.apply(value, f.client, params);
          },
    ]),
  );
  const admitted = await authenticatePreparedNpmArtifact({
    repository: f.repository,
    sourceSha: f.q,
    workflowSha: f.p,
    workflowFullRef: f.publisherFullRef,
    artifact,
    fullReleaseValidationRunId: f.runId,
    fullReleaseValidationRunAttempt: 1,
    releaseTag: "v" + f.source.projection?.version,
    selectionMode: "all-publishable",
    plugins: "",
    npmDistTag: "default",
    evidenceClient,
  });
  admitted.revalidateAuthority?.();
  expect(admitted.artifact).toEqual(artifact);
  expect(restReads).toHaveLength(30);
  expect(methodReads.revalidateQualificationAdmissionAuthority).toBe(3);
  console.info(
    "Prepared publisher fixture read accounting",
    JSON.stringify({ admissionRestReads: restReads.length, methodReads }),
  );
});
