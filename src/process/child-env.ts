/** Remove Gateway allocator tuning from a caller-owned child environment. */
export function stripGatewayAllocatorEnv(env: NodeJS.ProcessEnv): void {
  // jemalloc background threads break Chromium's single-threaded zygote fork;
  // profiling/decay settings belong to the Gateway, not its external tools.
  delete env.MALLOC_CONF;
  if (env.LD_PRELOAD !== undefined) {
    const preloads = env.LD_PRELOAD.split(/[\s:]+/u).filter(
      (library) => library && !/(?:^|\/)libjemalloc\.so(?:\.\d+)*$/u.test(library),
    );
    if (preloads.length > 0) {
      env.LD_PRELOAD = preloads.join(":");
    } else {
      delete env.LD_PRELOAD;
    }
  }
}
