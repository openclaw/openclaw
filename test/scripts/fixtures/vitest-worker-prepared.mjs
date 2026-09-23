import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { hashVitestWorkerArtifact } from "../../../scripts/lib/vitest-worker-artifacts.mts";

export async function copyPreparedWorkerArtifacts(template, directory) {
  const started = performance.now();
  const manifest = JSON.parse(fs.readFileSync(path.join(template, "manifest.json"), "utf8"));
  const sourceUrl = pathToFileURL(template).href;
  const targetUrl = pathToFileURL(directory).href;
  // The maintenance-service boundary embeds its generation URL. Rebind before sealing
  // the copy so no borrower reads through another generation's cleanup lifetime.
  const directories = new Map();
  const copyArtifact = async (name) => {
    const original = path.join(template, "dist", name);
    const source = await fs.promises.readFile(original);
    if (hashVitestWorkerArtifact(source) !== manifest.outputs[name]) {
      throw new Error(`Prepared compiler artifact changed: ${name}`);
    }
    const output = /\.m?js$/u.test(name)
      ? Buffer.from(source.toString("utf8").replaceAll(sourceUrl, targetUrl))
      : source;
    const filename = path.join(directory, "dist", name);
    const parent = path.dirname(filename);
    let created = directories.get(parent);
    if (!created) {
      created = fs.promises.mkdir(parent, { recursive: true });
      directories.set(parent, created);
    }
    await created;
    if (source.equals(output)) {
      await fs.promises.copyFile(original, filename, fs.constants.COPYFILE_FICLONE);
    } else {
      await fs.promises.writeFile(filename, output);
      manifest.outputs[name] = hashVitestWorkerArtifact(output);
    }
  };
  const names = Object.keys(manifest.outputs);
  const batchSize = 32;
  for (let offset = 0; offset < names.length; offset += batchSize) {
    // Join every started copy before the caller can dispose a failed generation.
    const completed = await Promise.allSettled(
      names.slice(offset, offset + batchSize).map(copyArtifact),
    );
    const failed = completed.find((result) => result.status === "rejected");
    if (failed) {
      throw failed.reason;
    }
  }
  manifest.identity = hashVitestWorkerArtifact(JSON.stringify([manifest.inputs, manifest.outputs]));
  manifest.durationMs = performance.now() - started;
  fs.writeFileSync(path.join(directory, "manifest.json"), JSON.stringify(manifest), { flag: "wx" });
}
