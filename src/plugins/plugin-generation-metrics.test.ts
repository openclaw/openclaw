import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { withArtifactPreservingStateReads } from "../state/artifact-preserving-state-reads.js";
import { capturePluginGenerationArtifact } from "./plugin-generation-artifact.js";
import {
  createPluginGenerationMetrics,
  withPluginGenerationMetrics,
} from "./plugin-generation-metrics.js";
import { withPluginGenerationSourceCustody } from "./plugin-generation-source-lookup.js";
import { preparePluginGenerationArtifact } from "./plugin-generation-worker.js";
import { withPluginSourceCaptureStorage } from "./plugin-source-capture-context.js";

const temp = useAutoCleanupTempDirTracker(afterEach);

it.each(["host", "worker"] as const)(
  "accounts for selected source and receipt bytes during %s preparation",
  async (location) => {
    const directory = fs.realpathSync(temp.make("plugin-preparation-metrics-"));
    const root = path.join(directory, "plugin");
    const dependency = path.join(root, "node_modules", "fixture-dependency");
    fs.mkdirSync(dependency, { recursive: true });
    const files: Array<[string, string]> = [
      [
        path.join(root, "package.json"),
        '{"name":"fixture","dependencies":{"fixture-dependency":"1.0.0"}}',
      ],
      [path.join(root, "index.cjs"), "exports.value = 42;"],
      [path.join(dependency, "package.json"), '{"name":"fixture-dependency","main":"index.cjs"}'],
      [path.join(dependency, "index.cjs"), "exports.value = 7;"],
      [path.join(dependency, "data.txt"), "retained fixture bytes"],
    ];
    for (const [filename, content] of files) {
      fs.writeFileSync(filename, content);
    }
    const bytes = files.reduce((total, [, content]) => total + Buffer.byteLength(content), 0);
    const metrics = createPluginGenerationMetrics();
    await withArtifactPreservingStateReads(() =>
      withPluginSourceCaptureStorage({ stateDir: directory, placement: "temporary" }, async () => {
        const baseline = capturePluginGenerationArtifact(root);
        try {
          const artifact = await withPluginGenerationMetrics(metrics, async () =>
            location === "host"
              ? capturePluginGenerationArtifact(root)
              : (
                  await preparePluginGenerationArtifact({
                    rootDir: root,
                    source: path.join(root, "index.cjs"),
                  })
                ).artifact,
          );
          try {
            expect(artifact.sourceDigest).toBe(baseline.sourceDigest);
            expect(fs.readFileSync(artifact.resolve(path.join(root, "index.cjs")), "utf8")).toBe(
              "exports.value = 42;",
            );
            expect(metrics).toMatchObject({
              captures: 1,
              captureReuse: 0,
              packageFiles: 2,
              dependencyFiles: 3,
              originalBytes: bytes,
              copiedBytes: bytes,
              receiptPasses: 1,
              receiptFileReads: 5,
              receiptReadBytes: bytes,
              hashReadBytes: bytes * 2,
            });
            if (location === "worker") {
              expect(metrics.workerMs).toBeGreaterThan(0);
              expect(metrics.hostMs).toBeGreaterThan(0);
            }
          } finally {
            await artifact.disposeAsync();
          }
        } finally {
          await baseline.disposeAsync();
        }
      }),
    );
  },
);

it("keeps completed preparation metrics unchanged by later lazy capture", async () => {
  const directory = fs.realpathSync(temp.make("plugin-preparation-metrics-lazy-"));
  const entry = path.join(directory, "index.cjs");
  const later = path.join(directory, "later.cjs");
  fs.writeFileSync(path.join(directory, "package.json"), '{"name":"fixture"}');
  fs.writeFileSync(entry, "exports.value = 1;");
  fs.writeFileSync(later, "exports.value = 2;");
  const metrics = createPluginGenerationMetrics();
  const artifact = withPluginSourceCaptureStorage(
    { stateDir: directory, placement: "temporary" },
    () =>
      withPluginGenerationMetrics(metrics, () =>
        capturePluginGenerationArtifact(directory, entry, (run) => run()),
      ),
  );
  try {
    const completed = { ...metrics };
    expect(artifact.hasSource(later)).toBe(false);
    const captured = artifact.captureResolvedModule(later);
    expect(captured && fs.readFileSync(captured, "utf8")).toBe("exports.value = 2;");
    expect(metrics).toEqual(completed);
  } finally {
    await artifact.disposeAsync();
  }
});

it("accounts for retained custody copies separately from original bytes", async () => {
  const directory = fs.realpathSync(temp.make("plugin-preparation-metrics-custody-"));
  const root = path.join(directory, "plugin");
  fs.mkdirSync(root);
  const files: Array<[string, string]> = [
    ["package.json", '{"name":"fixture"}'],
    ["index.cjs", "exports.value = 42;"],
  ];
  for (const [filename, content] of files) {
    fs.writeFileSync(path.join(root, filename), content);
  }
  const bytes = files.reduce((total, [, content]) => total + Buffer.byteLength(content), 0);
  await withPluginSourceCaptureStorage({ stateDir: directory, placement: "temporary" }, () =>
    withPluginGenerationSourceCustody(async () => {
      const firstMetrics = createPluginGenerationMetrics();
      const first = withPluginGenerationMetrics(firstMetrics, () =>
        capturePluginGenerationArtifact(root, undefined, (run) => run()),
      );
      try {
        const metrics = createPluginGenerationMetrics();
        const second = withPluginGenerationMetrics(metrics, () =>
          capturePluginGenerationArtifact(root, undefined, (run) => run()),
        );
        try {
          expect(firstMetrics).toMatchObject({ originalBytes: bytes, copiedBytes: bytes * 3 });
          expect(metrics).toMatchObject({
            captures: 1,
            captureReuse: 1,
            originalBytes: 0,
            copiedBytes: bytes,
            receiptPasses: 1,
            receiptFileReads: 2,
            receiptReadBytes: bytes,
          });
          const entry = path.join(root, "index.cjs");
          expect(second.resolve(entry)).not.toBe(first.resolve(entry));
          expect(fs.readFileSync(second.resolve(entry), "utf8")).toBe(files[1]![1]);
          expect(second.sourceDigest).toBe(first.sourceDigest);
        } finally {
          await second.disposeAsync();
        }
      } finally {
        await first.disposeAsync();
      }
    }),
  );
});
