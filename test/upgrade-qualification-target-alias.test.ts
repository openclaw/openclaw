import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import { admitSession } from "../scripts/lib/upgrade-qualification-inspector.mjs";
import { historicalObservationSchema } from "../scripts/lib/upgrade-qualification-observation-contract.mts";
import {
  bytes,
  sha,
  verifyArtifacts,
  verifyObservedEntry,
  verifyLiveTargetFile,
  assertObservationAudit,
} from "../scripts/lib/upgrade-qualification-observation-files.mjs";
import {
  observationFixture,
  observationRunId as originalRun,
  requiredItem,
} from "./upgrade-qualification.test-support.js";

const custody = vi.hoisted(() => ({ root: "" }));
// mock-isolation: Redirect qualification paths into private real disk fixtures; real hashing,
// file handles and symlink semantics remain exercised without creating /qualification on host.
vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<{ default: typeof fs }>();
  const disk = (filename: string) => filename.replace(/^\/qualification/u, custody.root);
  return {
    default: {
      ...original.default,
      open: (filename: string, flags: string | number, mode?: number) =>
        original.default.open(disk(filename), flags, mode),
      realpath: async (filename: string) =>
        (await original.default.realpath(disk(filename))).replace(custody.root, "/qualification"),
    },
  };
});

const installation = "/qualification/npm/lib/node_modules/openclaw";
const code = "export const exact = true;\n";
let actual: typeof fs;
const write = async (filename: string, content: string) => {
  const disk = filename.replace(/^\/qualification/u, custody.root);
  await actual.mkdir(path.dirname(disk), { recursive: true });
  await actual.writeFile(disk, content);
  return { path: filename, sha256: sha(Buffer.from(content)), length: Buffer.byteLength(content) };
};
let entry: Awaited<ReturnType<typeof write>>;
let manifest: Awaited<ReturnType<typeof write>>;
const mapping = (phase: "fresh" | "retained", id: string = phase) => ({
  id,
  phase,
  entry,
  script: entry,
  liveTarget: { entry: `${installation}/dist/entry.js`, script: `${installation}/dist/entry.js` },
  location: { lineNumber: 0, columnNumber: 0 },
  guardExpression: "true",
  actionId: "core.package-publish",
  operation: "package.publish",
  jobId: "target-job",
  semanticAudit: entry,
  source: entry,
  sourceMap: entry,
  sourceName: "src/owner.ts",
  sourceLocation: { lineNumber: 0, columnNumber: 0 },
  facts: { runId: "runId", actionId: "actionId", operation: "operation", jobId: "jobId" },
});
const binding = () => ({
  ...observationFixture(entry.path),
  boundary: "package-publication",
  observer: { ...entry, path: "/qualification/tools/observer.mjs" },
  observerFiles: [
    "observer.mjs",
    "upgrade-qualification-inspector.mjs",
    "upgrade-qualification-observation-files.mjs",
  ].map((name) => Object.assign({}, entry, { path: `/qualification/tools/${name}` })),
  runtime: entry,
  nativeBootstrap: entry,
  artifacts: [entry, manifest],
  targetInstallation: {
    manifest,
    releaseId: "target",
    buildId: "build",
    packageArtifactId: "package",
  },
  mappings: [
    mapping("fresh"),
    mapping("retained"),
    {
      ...mapping("fresh", "capture"),
      location: { lineNumber: 1, columnNumber: 0 },
      sourceName: "src/cli/update-cli/recipe-plan.ts",
      captureRunExpression: "runId",
      captureStage: "recipe-plan-uuid-before-ledger-admission",
    },
  ],
  durableProbe: { executable: entry, argv: [originalRun], expected: {}, audit: entry },
});

async function inspectLoadedTarget(scriptSource: string) {
  const selected = historicalObservationSchema.parse(binding());
  const mapped = requiredItem(selected.mappings);
  await write(mapped.liveTarget!.script, code);
  let finish: (error?: Error) => void = () => {};
  const settled = new Promise<Error | undefined>((resolve) => {
    finish = resolve;
  });
  const handlers: Array<(event: unknown) => void> = [];
  const emit = (event: unknown) => handlers.forEach((handler) => handler(event));
  const liveAdmission = vi.fn();
  let resumes = 0;
  const transport = {
    handlers,
    call: vi.fn(async (method: string) => {
      if (method === "Runtime.runIfWaitingForDebugger") {
        emit({ method: "Debugger.paused", params: { reason: "Break on start", callFrames: [] } });
      }
      if (method === "Runtime.evaluate") {
        return { result: { value: 42 } };
      }
      if (method === "Debugger.setInstrumentationBreakpoint") {
        return { breakpointId: "gate" };
      }
      if (method === "Debugger.getScriptSource") {
        return { scriptSource };
      }
      if (method === "Debugger.setBreakpoint") {
        return { breakpointId: "boundary", actualLocation: mapped.location };
      }
      if (method === "Debugger.resume" && ++resumes === 2) {
        finish();
      }
      return {};
    }),
  };
  await admitSession({
    transport,
    mappings: [mapped],
    binding: selected,
    phase: "fresh",
    process: { pid: 42 },
    onBoundary: vi.fn(),
    onError: finish,
    originalRunId: () => originalRun,
    onCaptureRun: vi.fn(),
    onLiveTarget: liveAdmission,
    worker: undefined,
    onWorker: undefined,
  });
  emit({
    method: "Debugger.scriptParsed",
    params: { scriptId: "target", url: new URL(`file://${mapped.liveTarget!.script}`).href },
  });
  emit({
    method: "Debugger.paused",
    params: {
      reason: "instrumentation",
      hitBreakpoints: ["gate"],
      data: { scriptId: "target" },
      callFrames: [{ location: { scriptId: "target" } }],
    },
  });
  return { mapped, transport, liveAdmission, error: await settled };
}

beforeAll(async () => {
  actual = (await vi.importActual<{ default: typeof fs }>("node:fs/promises")).default;
  custody.root = await actual.mkdtemp(path.join(os.tmpdir(), "upgrade-live-alias-"));
  entry = await write("/qualification/references/entry.js", code);
  manifest = await write(
    "/qualification/references/target-manifest.json",
    JSON.stringify({
      schemaVersion: 1,
      releaseId: "target",
      buildId: "build",
      packageArtifactId: "package",
      directories: ["dist"],
      files: [
        {
          kind: "file",
          path: "dist/entry.js",
          sha256: entry.sha256,
          length: entry.length,
          mode: 0o644,
        },
      ],
    }),
  );
});
afterAll(async () => {
  await actual.rm(custody.root, { recursive: true });
});

describe("immutable references and publication-time target aliases", () => {
  it("preflights immutable references without reading or changing old historical target paths", async () => {
    const selected = historicalObservationSchema.parse(binding());
    await write(requiredItem(selected.mappings).liveTarget!.entry, "historical source bytes");
    await expect(verifyArtifacts(selected)).resolves.toBeUndefined();
    await expect(verifyObservedEntry(requiredItem(selected.mappings), selected)).rejects.toThrow(
      /Immutable artifact changed/,
    );
    const disk = requiredItem(selected.mappings).liveTarget!.entry.replace(
      /^\/qualification/u,
      custody.root,
    );
    expect(await actual.readFile(disk, "utf8")).toBe("historical source bytes");
    await actual.unlink(disk);
    await expect(verifyArtifacts(selected)).resolves.toBeUndefined();
    await expect(
      verifyObservedEntry(requiredItem(selected.mappings), selected),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
  it("admits only exact live canonical target entries after publication and refuses later changes", async () => {
    const selected = historicalObservationSchema.parse(binding());
    const live = requiredItem(selected.mappings).liveTarget!.entry;
    await write(live, code);
    const admitted = await verifyObservedEntry(requiredItem(selected.mappings), selected);
    expect(admitted).toEqual({ ...entry, path: live });
    if (!admitted) {
      throw new Error("Missing live artifact admission");
    }
    await write(live, "tampered target bytes");
    await expect(bytes(admitted)).rejects.toThrow(/Immutable artifact changed/);
    await write(live, code);
    await expect(
      verifyLiveTargetFile(selected, live, { ...entry, sha256: "b".repeat(64) }),
    ).rejects.toThrow(/reviewed reference/);
    const disk = live.replace(/^\/qualification/u, custody.root);
    await actual.unlink(disk);
    await actual.symlink(entry.path.replace(/^\/qualification/u, custody.root), disk);
    await expect(verifyObservedEntry(requiredItem(selected.mappings), selected)).rejects.toThrow(
      /Noncanonical/,
    );
    await actual.unlink(disk);
  });
  it("rejects aliases outside native installation, missing manifest and mutable reference paths", () => {
    for (const modify of [
      (input: ReturnType<typeof binding>) => {
        requiredItem(input.mappings).liveTarget.entry = "/qualification/foreign/entry.js";
      },
      (input: ReturnType<typeof binding>) => {
        requiredItem(input.mappings).liveTarget.script = `${installation}/dist/../entry.js`;
      },
      (input: ReturnType<typeof binding>) => {
        input.artifacts = [entry];
      },
      (input: ReturnType<typeof binding>) => {
        input.artifacts.push({ ...entry, path: `${installation}/dist/entry.js` });
      },
    ]) {
      const selected = binding();
      modify(selected);
      expect(() => historicalObservationSchema.parse(selected)).toThrow();
    }
  });
  it("preserves runner-only bindings and refuses live aliases without a target manifest", () => {
    expect(() =>
      historicalObservationSchema.parse({ ...binding(), targetInstallation: undefined }),
    ).toThrow();
    const runnerOnly = {
      ...binding(),
      targetInstallation: undefined,
      artifacts: [entry],
      mappings: binding().mappings.map(({ liveTarget: _alias, ...item }) => item),
    };
    expect(() => historicalObservationSchema.parse(runnerOnly)).not.toThrow();
  });
  it("rejects an immutable manifest for another release/build and undeclared live scripts", async () => {
    const selected = binding();
    const wrong = await write(
      "/qualification/references/wrong-manifest.json",
      JSON.stringify({
        schemaVersion: 1,
        releaseId: "target",
        buildId: "other-build",
        packageArtifactId: "package",
        directories: [],
        files: [],
      }),
    );
    selected.targetInstallation.manifest = wrong;
    await expect(verifyLiveTargetFile(selected, `${installation}/dist/entry.js`)).rejects.toThrow(
      /full installation-manifest/,
    );
    await expect(
      verifyLiveTargetFile(binding(), `${installation}/dist/undeclared.js`),
    ).rejects.toThrow(/reviewed reference/);
  });
  it("binds reviewed semantic identity to the exact live paths and full manifest digest", () => {
    const selected = binding(),
      mapped = requiredItem(selected.mappings);
    const audit = {
      ...mapped,
      purpose: "reviewed-unchanged-artifact-boundary",
      boundary: selected.boundary,
      side: selected.side,
      runId: selected.runId,
      mappingId: mapped.id,
      scriptSha256: mapped.script.sha256,
      entrySha256: mapped.entry.sha256,
      sourceSha256: mapped.source.sha256,
      sourceMapSha256: mapped.sourceMap.sha256,
      targetInstallationManifestSha256: manifest.sha256,
      guardReadOnly: true,
      effectOrdering: true,
      basis: "Exact reviewed target load and commit owner.",
    };
    expect(() => assertObservationAudit(audit, mapped, selected)).not.toThrow();
    expect(() =>
      assertObservationAudit(
        { ...audit, liveTarget: { ...mapped.liveTarget, script: `${installation}/dist/other.js` } },
        mapped,
        selected,
      ),
    ).toThrow(/exact inputs/);
    expect(() =>
      assertObservationAudit(
        { ...audit, targetInstallationManifestSha256: "b".repeat(64) },
        mapped,
        selected,
      ),
    ).toThrow(/exact inputs/);
  });
  it("arms exact V8 target bytes at the live alias before releasing execution", async () => {
    const { mapped, transport, liveAdmission, error } = await inspectLoadedTarget(code);
    expect(error).toBeUndefined();
    expect(liveAdmission).toHaveBeenCalledWith({ ...entry, path: mapped.liveTarget!.script });
    expect(transport.call).toHaveBeenCalledWith("Debugger.setBreakpoint", {
      location: { scriptId: "target", ...mapped.location },
    });
  });
  it("holds execution when V8 live script source differs, even if the live disk file is exact", async () => {
    const { transport, liveAdmission, error } = await inspectLoadedTarget("different V8 bytes");
    expect(error?.message).toMatch(/authenticated closure/);
    expect(liveAdmission).not.toHaveBeenCalled();
    expect(
      transport.call.mock.calls.filter(([method]) => method === "Debugger.resume"),
    ).toHaveLength(1);
    expect(transport.call).not.toHaveBeenCalledWith("Debugger.setBreakpoint", expect.anything());
  });
});
