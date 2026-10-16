import { runInNewContext } from "node:vm";
import { expect, it, vi } from "vitest";
import type { WorkerSshEndpoint } from "../../plugins/types.js";
import type { bootstrapWorker as bootstrapWorkerCore } from "./bootstrap.js";
import { fakeRunner, result } from "./bootstrap.test-support.js";
import type { WorkerInstallationArtifact } from "./bundle.js";

export function registerBootstrapRuntimeProbeTests({
  bootstrapWorker,
  resolveIdentity,
  ssh: SSH,
  artifact: BUNDLE,
  currentReceipt,
}: {
  bootstrapWorker: (
    request: Pick<Parameters<typeof bootstrapWorkerCore>[0], "ssh" | "artifact">,
    dependencies: Parameters<typeof bootstrapWorkerCore>[1],
  ) => ReturnType<typeof bootstrapWorkerCore>;
  resolveIdentity: NonNullable<Parameters<typeof bootstrapWorkerCore>[1]["resolveIdentity"]>;
  ssh: WorkerSshEndpoint;
  artifact: WorkerInstallationArtifact;
  currentReceipt: string;
}): void {
  it("settles the generated runtime probe without continuing after rejected admission", async () => {
    const runner = fakeRunner([result({ stdout: currentReceipt })]);
    await bootstrapWorker(
      { ssh: SSH, artifact: BUNDLE },
      { resolveIdentity, runCommand: runner.runCommand },
    );
    const script = String(runner.calls[0]?.options.input).match(
      /if ! node -e '([^']*)'; then/u,
    )?.[1];
    expect(script).toBeDefined();
    for (const scenario of [
      "unsupported-node",
      "invalid-sqlite",
      "query-failed",
      "supported",
    ] as const) {
      const close = vi.fn();
      const loadSqlite = vi.fn(() => ({
        DatabaseSync: class {
          close = close;
          prepare() {
            return {
              get() {
                if (scenario === "query-failed") {
                  throw new Error("probe failed");
                }
                return { version: scenario === "invalid-sqlite" ? "invalid" : "3.51.3" };
              },
            };
          }
        },
      }));
      const forcedExit = vi.fn(() => {
        throw new Error("forced exit");
      });
      const child = {
        versions: { node: scenario === "unsupported-node" ? "22.0.0" : "26.1.0" },
        exitCode: 0,
        exit: forcedExit,
        reallyExit: forcedExit,
      };
      runInNewContext(script!, {
        process: child,
        require: (name: string) => {
          if (name === "node:process" || name === "process") {
            return child;
          }
          if (name === "node:sqlite") {
            return loadSqlite();
          }
          throw new Error("unexpected dependency: " + name);
        },
      });
      expect(child.exitCode, scenario).toBe(scenario === "supported" ? 0 : 1);
      expect(forcedExit, scenario).not.toHaveBeenCalled();
      expect(loadSqlite, scenario).toHaveBeenCalledTimes(scenario === "unsupported-node" ? 0 : 1);
      expect(close, scenario).toHaveBeenCalledTimes(scenario === "unsupported-node" ? 0 : 1);
    }
  });
}
