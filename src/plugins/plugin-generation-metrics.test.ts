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
            // Worker preparation captures once, copies custody for transfer, then
            // reconstructs and admits the same bytes in the host without another copy.
            const capturePasses = location === "worker" ? 2 : 1;
            expect(metrics).toMatchObject({
              captures: capturePasses,
              captureReuse: capturePasses - 1,
              packageFiles: 2 * capturePasses,
              dependencyFiles: 3 * capturePasses,
              originalBytes: bytes,
              copiedBytes: bytes * capturePasses,
              receiptPasses: capturePasses,
              receiptFileReads: files.length * capturePasses,
              receiptReadBytes: bytes * capturePasses,
              hashReadBytes: bytes * (capturePasses + 1),
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
  const entry = path.join(root, "index.cjs");
  await withPluginSourceCaptureStorage({ stateDir: directory, placement: "temporary" }, () =>
    withPluginGenerationSourceCustody(async () => {
      const firstMetrics = createPluginGenerationMetrics();
      const first = (
        await withPluginGenerationMetrics(firstMetrics, () =>
          preparePluginGenerationArtifact({ rootDir: root, source: entry }),
        )
      ).artifact;
      try {
        const metrics = createPluginGenerationMetrics();
        const second = (
          await withPluginGenerationMetrics(metrics, () =>
            preparePluginGenerationArtifact({ rootDir: root, source: entry }),
          )
        ).artifact;
        try {
          // First preparation admits the seed, worker fork, and host reconstruction.
          // Each consumer copies seed custody and transfer custody, but only the seed
          // selects original bytes. Both consumer isolates verify their own receipt.
          expect(firstMetrics).toMatchObject({
            captures: 3,
            captureReuse: 2,
            packageFiles: files.length * 3,
            dependencyFiles: 0,
            originalBytes: bytes,
            copiedBytes: bytes * 3,
            receiptPasses: 3,
            receiptFileReads: files.length * 3,
            receiptReadBytes: bytes * 3,
            hashReadBytes: bytes * 4,
          });
          expect(metrics).toMatchObject({
            captures: 2,
            captureReuse: 2,
            packageFiles: files.length * 2,
            dependencyFiles: 0,
            originalBytes: 0,
            copiedBytes: bytes * 2,
            receiptPasses: 2,
            receiptFileReads: files.length * 2,
            receiptReadBytes: bytes * 2,
            hashReadBytes: bytes * 2,
          });
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
