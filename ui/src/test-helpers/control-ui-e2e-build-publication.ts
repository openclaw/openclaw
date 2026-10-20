import { rename } from "node:fs/promises";
import type { Readable } from "node:stream";
import type { Plugin } from "vite";
import { createDeferredCore } from "../../../src/shared/deferred.ts";

/** Keep each preview response on one deployment while replacing its served directory. */
export function createControlUiE2eBuildPublication(outDir: string): {
  plugin: Plugin;
  replaceBuild: (nextDir: string, previousDir: string) => Promise<void>;
} {
  const active = new Set<Promise<void>>();
  const waiting = new Set<() => void>();
  let paused = false;

  return {
    plugin: {
      name: "control-ui-e2e-build-publication",
      configurePreviewServer(server) {
        server.middlewares.use((_request, response, next) => {
          const cancel = () => waiting.delete(admit);
          const admit = () => {
            waiting.delete(admit);
            response.off("close", cancel);
            if (response.destroyed) {
              return;
            }
            const completion = createDeferredCore();
            active.add(completion.promise);
            const sources = new Set<Readable>();
            let finished = false;
            const settle = () => {
              if (!finished || sources.size) {
                return;
              }
              response.off("pipe", onPipe);
              response.off("finish", onFinish);
              response.off("close", onClose);
              active.delete(completion.promise);
              completion.resolve();
            };
            const onPipe = (source: Readable) => {
              sources.add(source);
              source.once("close", () => {
                sources.delete(source);
                settle();
              });
            };
            const onFinish = () => {
              finished = true;
              settle();
            };
            const onClose = () => {
              // A cancelled response can leave its file stream waiting for an asynchronous open.
              for (const source of sources) {
                source.destroy();
              }
              onFinish();
            };
            response.on("pipe", onPipe);
            response.once("finish", onFinish);
            response.once("close", onClose);
            next();
          };
          if (paused) {
            waiting.add(admit);
            response.once("close", cancel);
          } else {
            admit();
          }
        });
      },
    },
    async replaceBuild(nextDir, previousDir) {
      if (paused) {
        throw new Error("A Control UI fixture build replacement is already in progress");
      }
      paused = true;
      try {
        await Promise.all(active);
        await rename(outDir, previousDir);
        try {
          await rename(nextDir, outDir);
        } catch (error) {
          await rename(previousDir, outDir);
          throw error;
        }
      } finally {
        paused = false;
        for (const resume of Array.from(waiting)) {
          resume();
        }
      }
    },
  };
}
