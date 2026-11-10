export function createStartupTraceRecorder() {
  const details: Array<{
    name: string;
    metrics: ReadonlyArray<readonly [string, number | string]>;
  }> = [];
  const marks: string[] = [];
  const measures: string[] = [];
  return {
    details,
    marks,
    measures,
    startupTrace: {
      detail: (name: string, metrics: ReadonlyArray<readonly [string, number | string]>) => {
        details.push({ name, metrics });
      },
      mark: (name: string) => {
        marks.push(name);
      },
      measure: async <T>(name: string, run: () => T | Promise<T>) => {
        measures.push(name);
        return await run();
      },
    },
  };
}
