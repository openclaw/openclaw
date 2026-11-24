/** Apply priority to the child, never the Gateway or a concurrent foreground operation. */
export function idleIoPriorityArgv(argv: string[], idle?: boolean): string[] {
  if (!idle) {
    return argv;
  }
  if (process.platform === "linux") {
    return ["ionice", "-c", "3", ...argv];
  }
  if (process.platform === "darwin") {
    return ["taskpolicy", "-b", ...argv];
  }
  return argv;
}
