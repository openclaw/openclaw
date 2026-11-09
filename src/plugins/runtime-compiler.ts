import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createRequire } from "node:module";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";

const require = createRequire(import.meta.url);

export const catalogOperations = resolveGlobalSingleton<{
  pending?: Promise<void>;
  failure?: unknown;
}>(
  Symbol.for("openclaw.controlUiPluginCatalogOperations"),
  () => ({}),
  async (state) => {
    await state.pending;
    if ("failure" in state) {
      throw state.failure;
    }
  },
  "plugin-registry",
);

// The isolated host owns esbuild's async service and joins it before closing IPC.
const browserCompilerHost = `
const {once}=require('node:events');
const children=[];
require('node:diagnostics_channel').channel('child_process').subscribe(({process:child})=>{
  const closed=once(child,'close'); closed.catch(()=>{}); children.push({child,closed});
});
const esbuild=require(process.argv[1]);
const stop=async()=>{
  for(const {child} of children) child.ref();
  esbuild.stop(); await Promise.all(children.map(({closed})=>closed));
  process.removeAllListeners('disconnect'); if(process.connected) process.disconnect();
};
process.once('disconnect',stop);
process.on('message',async source=>{
  if(source===false) return stop();
  let imports=[];
  try { const result=await esbuild.build({stdin:{contents:source,loader:'js'},format:'esm',treeShaking:false,write:false,metafile:true,logLevel:'silent'}); imports=Object.values(result.metafile.outputs).flatMap(output=>output.imports); } catch {}
  if(process.connected) process.send(imports);
});
`;

export function createPluginBrowserCompiler() {
  let child: ChildProcess | undefined;
  let closed: Promise<unknown[]> | undefined;
  return {
    async imports(source: string) {
      if (!child) {
        child = spawn(process.execPath, ["-e", browserCompilerHost, require.resolve("esbuild")], {
          windowsHide: true,
          stdio: ["ignore", "ignore", "inherit", "ipc"],
        });
        closed = once(child, "close");
      }
      const response = once(child, "message");
      child.send!(source);
      const [imports] = await Promise.race([response, closed!]);
      if (!Array.isArray(imports)) {
        throw new Error("Browser compiler exited before replying");
      }
      // SAFETY: Our private host sends only esbuild import records; close tuples were rejected above.
      return imports as import("esbuild").Metafile["outputs"][string]["imports"];
    },
    async [Symbol.asyncDispose]() {
      try {
        if (child?.connected) {
          child.send!(false);
        }
        if (closed) {
          const [code] = await closed;
          if (code !== 0) {
            throw new Error("Browser compiler did not close cleanly");
          }
        }
      } catch (error) {
        catalogOperations.failure ??= error;
        throw error;
      }
    },
  };
}
