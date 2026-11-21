import type { SpawnStdioEntry } from "../spawn-secret-input.js";

export function setStdioEntry(stdio: SpawnStdioEntry[], fd: number, value: SpawnStdioEntry): void {
  while (stdio.length <= fd) {
    stdio.push("ignore");
  }
  stdio[fd] = value;
}

export function reserveStdioEntry(stdio: SpawnStdioEntry[], value: SpawnStdioEntry): number {
  let fd = 3;
  while (stdio[fd] !== undefined && stdio[fd] !== "ignore") {
    fd += 1;
  }
  setStdioEntry(stdio, fd, value);
  return fd;
}
