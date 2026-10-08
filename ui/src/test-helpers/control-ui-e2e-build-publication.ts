import { rename } from "node:fs/promises";
import type { ServerResponse } from "node:http";
import type { Readable } from "node:stream";
import type { Plugin } from "vite";

/** Keep each preview response on one deployment while replacing its served directory. */
export function createControlUiE2eBuildPublication(outDir: string): {
  plugin: Plugin;
  replaceBuild: (nextDir: string, previousDir: string) => Promise<void>;
} {
  const active = new Set<ServerResponse>();
  const waiting = new Set<() => void>();
  let paused = false;
  let resolveDrain: (() => void) | undefined;

  return {
    plugin: {
      name: "control-ui-e2e-build-publication",
      configurePreviewServer(server) {
        server.middlewares.use((_request, response, next) => {
          const admit = () => {
            if (response.destroyed) {
              return;
            }
            active.add(response);
            const sources = new Set<Readable>();
            let finished = false;
            const settle = () => {
              if (!finished || sources.size) {
                return;
              }
              response.off("pipe", onPipe);
              response.off("finish", onFinish);
              response.off("close", onClose);
              active.delete(response);
              if (active.size === 0) {
                resolveDrain?.();
              }
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
              finished = true;
              // A cancelled response can leave its file stream waiting for an asynchronous open.
              for (const source of sources) {
                source.destroy();
              }
              settle();
            };
            response.on("pipe", onPipe);
            response.once("finish", onFinish);
            response.once("close", onClose);
            next();
          };
          if (!paused) {
            admit();
            return;
          }
          const cancel = () => waiting.delete(resume);
          const resume = () => {
            waiting.delete(resume);
            response.off("close", cancel);
            admit();
          };
          waiting.add(resume);
          response.once("close", cancel);
        });
      },
    },
    async replaceBuild(nextDir, previousDir) {
      if (paused) {
        throw new Error("A Control UI fixture build replacement is already in progress");
      }
      paused = true;
      try {
        if (active.size) {
          await new Promise<void>((resolve) => {
            resolveDrain = resolve;
          });
        }
        await rename(outDir, previousDir);
        try {
          await rename(nextDir, outDir);
        } catch (error) {
          await rename(previousDir, outDir);
          throw error;
        }
      } finally {
        resolveDrain = undefined;
        paused = false;
        for (const resume of Array.from(waiting)) {
          resume();
        }
      }
    },
  };
}
