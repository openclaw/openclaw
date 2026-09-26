// Real process fixture; the test runner compiles its dependency graph before admission.
import { runWorkerProcess } from "./worker-process.js";
try {
  await runWorkerProcess({ managed: true });
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
