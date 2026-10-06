import path from "node:path";
import type {
  MemoryWorkspaceFiles,
  MemoryWorkspaceMaintenance,
  MemoryWorkspaceWatchRequest,
} from "../../packages/memory-host-sdk/src/host/workspace-files.js";

/** Client for the packaged, same-version Memory file worker, independent of its transport. */
export function createWorkspaceMemoryFileClient(options: {
  workspaceDir: string;
  /** POSIX workspace path on the remote host. */
  remoteWorkspaceDir: string;
  signal: AbortSignal;
  /** Deliver one JSON request on stdin and return stdout; reject incomplete replies. */
  request: (request: string, signal: AbortSignal) => Promise<string>;
  /** Deliver one JSON line, stream reply lines, and close the remote worker on abort. */
  subscribe: (
    request: string,
    onLine: (line: string) => void,
    signal: AbortSignal,
  ) => Promise<void>;
}): MemoryWorkspaceFiles {
  const workspaceDir = path.resolve(options.workspaceDir);
  const remoteWorkspaceDir = path.posix.resolve(options.remoteWorkspaceDir);
  const outside = (relative: string, paths: typeof path) =>
    relative === ".." || relative.startsWith(`..${paths.sep}`) || paths.isAbsolute(relative);
  const host = (file: string) => {
    const relative = path.relative(workspaceDir, file);
    return outside(relative, path)
      ? file
      : path.posix.join(remoteWorkspaceDir, ...relative.split(path.sep));
  };
  const gateway = (file: string) => {
    const relative = path.posix.relative(remoteWorkspaceDir, file);
    return outside(relative, path.posix) ? file : path.join(workspaceDir, ...relative.split("/"));
  };
  const extra = (paths: MemoryWorkspaceWatchRequest["settings"]["extraPaths"] = []) =>
    paths.map((entry) => {
      const mapped = (file: string) => (path.isAbsolute(file) ? host(file) : file);
      return typeof entry === "string" ? mapped(entry) : { ...entry, path: mapped(entry.path) };
    });

  async function call<T>(request: Record<string, unknown>): Promise<T> {
    options.signal.throwIfAborted();
    let response: {
      result: T;
      error?: { message: string; code?: string; name?: string; publication?: string };
    };
    try {
      const reply = await options.request(JSON.stringify(request), options.signal);
      options.signal.throwIfAborted();
      // SAFETY: The same-version Memory worker serializes this operation's result or error envelope.
      response = JSON.parse(reply) as typeof response;
    } catch (error) {
      if (request.operation === "maintenance" && request.method === "commitContent") {
        throw Object.assign(new Error("Memory write outcome is unknown", { cause: error }), {
          publication: "uncertain",
        });
      }
      throw error;
    }
    if (response.error) {
      throw Object.assign(new Error(response.error.message), {
        ...(response.error.code ? { code: response.error.code } : {}),
        ...(response.error.name ? { name: response.error.name } : {}),
        ...(["uncertain", "committed"].includes(response.error.publication ?? "")
          ? { publication: response.error.publication }
          : {}),
      });
    }
    return response.result;
  }
  const maintain = <T>(method: keyof MemoryWorkspaceMaintenance, ...args: unknown[]) =>
    call<T>({ operation: "maintenance", method, args });
  return {
    maintenance: {
      readFile: async (file) =>
        Buffer.from(await maintain<string>("readFile", host(file)), "base64"),
      stat: (file, follow) => maintain("stat", host(file), follow),
      listDirectory: (directory) => maintain("listDirectory", host(directory)),
      mkdir: (directory) => maintain("mkdir", host(directory)),
      rename: (from, to) => maintain("rename", host(from), host(to)),
      resolveWritePath: async (file) => gateway(await maintain("resolveWritePath", host(file))),
      commitContent: (params) =>
        maintain("commitContent", { ...params, filePath: host(params.filePath) }),
      resolveDreamsPath: async () => gateway(await maintain("resolveDreamsPath")),
      readDreams: (file) => maintain("readDreams", host(file)),
      writeDreams: (file, content) => maintain("writeDreams", host(file), content),
      replaceReport: (file, content) => maintain("replaceReport", host(file), content),
      appendCorpus: (file, content) => maintain("appendCorpus", host(file), content),
    },
    assertCurrent: () => options.signal.throwIfAborted(),
    async listFiles(_workspace, extraPaths, multimodal, skipped) {
      const result = await call<{ files: string[]; skipped: string[] }>({
        operation: "list",
        extraPaths: extra(extraPaths),
        multimodal,
      });
      for (const file of result.skipped) {
        skipped?.(gateway(file));
      }
      return result.files.map(gateway);
    },
    async inspectFile(file, _workspace, multimodal) {
      const result = await call<Awaited<ReturnType<MemoryWorkspaceFiles["inspectFile"]>>>({
        operation: "inspect",
        filePath: host(file),
        multimodal,
      });
      return result ? { ...result, absPath: gateway(result.absPath) } : null;
    },
    readFile({ workspaceDir: _workspace, extraPaths, relPath, ...params }) {
      return call({
        operation: "read",
        params: {
          ...params,
          extraPaths: extra(extraPaths),
          relPath: path.isAbsolute(relPath) ? host(relPath) : relPath,
        },
      });
    },
    readForIndexing: (file) => call({ operation: "readForIndexing", filePath: host(file) }),
    buildMultimodalChunk: (entry) =>
      call({ operation: "multimodal", entry: { ...entry, absPath: host(entry.absPath) } }),
    async watch(request, onChange, signal) {
      const active = AbortSignal.any([options.signal, signal]);
      active.throwIfAborted();
      // Do not forward an entire search config: embedding credentials stay on Gateway.
      const mapped: MemoryWorkspaceWatchRequest = {
        agentId: request.agentId,
        settings: {
          extraPaths: extra(request.settings.extraPaths),
          multimodal: request.settings.multimodal,
          sync: { watchDebounceMs: request.settings.sync.watchDebounceMs },
        },
      };
      await options.subscribe(
        `${JSON.stringify(mapped)}\n`,
        (line) => {
          active.throwIfAborted();
          const event: unknown = JSON.parse(line);
          if (event !== "change" && event !== "unavailable") {
            throw new Error("Invalid Memory change notification");
          }
          onChange(event);
        },
        active,
      );
      if (!active.aborted) {
        onChange("unavailable");
      }
    },
  };
}
