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
  for (const name of Object.keys(manifest.outputs)) {
    const original = path.join(template, "dist", name);
    const source = fs.readFileSync(original);
    if (hashVitestWorkerArtifact(source) !== manifest.outputs[name]) {
      throw new Error(`Prepared compiler artifact changed: ${name}`);
    }
    const output = /\.m?js$/u.test(name)
      ? Buffer.from(source.toString("utf8").replaceAll(sourceUrl, targetUrl))
      : source;
    const filename = path.join(directory, "dist", name);
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    if (source.equals(output)) {
      fs.copyFileSync(original, filename, fs.constants.COPYFILE_FICLONE);
    } else {
      fs.writeFileSync(filename, output);
      manifest.outputs[name] = hashVitestWorkerArtifact(output);
    }
  }
  manifest.identity = hashVitestWorkerArtifact(JSON.stringify([manifest.inputs, manifest.outputs]));
  manifest.durationMs = performance.now() - started;
  fs.writeFileSync(path.join(directory, "manifest.json"), JSON.stringify(manifest), { flag: "wx" });
}
